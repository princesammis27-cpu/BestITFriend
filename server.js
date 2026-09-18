import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import pg from "pg";

dotenv.config();
const { Pool } = pg;
const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const PORT = Number(process.env.PORT || 3000);
const SANDBOX = "https://sandbox.safaricom.co.ke";

function required(name){
  const v=process.env[name];
  if(!v) throw new Error(`Missing environment variable: ${name}`);
  return v;
}

function timestamp(){
  const d=new Date();
  const p=n=>String(n).padStart(2,"0");
  return `${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function normalizePhone(v){
  const p=String(v||"").replace(/\s+/g,"").replace(/-/g,"");
  if(/^07\d{8}$/.test(p) || /^01\d{8}$/.test(p)) return "254"+p.slice(1);
  if(/^\+254[71]\d{8}$/.test(p)) return p.slice(1);
  if(/^254[71]\d{8}$/.test(p)) return p;
  return null;
}

async function getAccessToken(){
  const key=required("MPESA_CONSUMER_KEY");
  const secret=required("MPESA_CONSUMER_SECRET");
  const auth=Buffer.from(`${key}:${secret}`).toString("base64");
  const r=await fetch(`${SANDBOX}/oauth/v1/generate?grant_type=client_credentials`,{
    headers:{Authorization:`Basic ${auth}`}
  });
  const d=await r.json();
  if(!r.ok || !d.access_token) throw new Error(d.errorMessage || "Daraja OAuth failed");
  return d.access_token;
}

app.get("/health", async (_req,res)=>{
  try{ await pool.query("SELECT 1"); res.json({ok:true,service:"princesammis-daraja-backend"}); }
  catch(e){ res.status(500).json({ok:false,error:e.message}); }
});

app.post("/api/mpesa/stk-push", async (req,res)=>{
  try{
    const productId=String(req.body.productId||"").trim();
    const amount=Math.round(Number(req.body.amount));
    const phone=normalizePhone(req.body.phone);
    if(!productId) return res.status(400).json({error:"productId is required"});
    if(!Number.isFinite(amount) || amount<1) return res.status(400).json({error:"Invalid amount"});
    if(!phone) return res.status(400).json({error:"Invalid Kenyan phone number"});

    // SANDBOX NOTE: the current uploaded HTML does not contain product prices.
    // Before production, store prices on the server/database and ignore client amount.

    const shortcode=required("MPESA_SHORTCODE");
    const passkey=required("MPESA_PASSKEY");
    const callback=required("MPESA_CALLBACK_URL");
    const transactionType=process.env.MPESA_TRANSACTION_TYPE || "CustomerPayBillOnline";
    const ts=timestamp();
    const password=Buffer.from(`${shortcode}${passkey}${ts}`).toString("base64");
    const token=await getAccessToken();

    const payload={
      BusinessShortCode:shortcode,
      Password:password,
      Timestamp:ts,
      TransactionType:transactionType,
      Amount:amount,
      PartyA:phone,
      PartyB:shortcode,
      PhoneNumber:phone,
      CallBackURL:callback,
      AccountReference:`PNF-${productId.slice(0,20)}`,
      TransactionDesc:"Digital product purchase"
    };

    const r=await fetch(`${SANDBOX}/mpesa/stkpush/v1/processrequest`,{
      method:"POST",
      headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},
      body:JSON.stringify(payload)
    });
    const d=await r.json();
    if(!r.ok || !d.CheckoutRequestID){
      return res.status(502).json({error:d.errorMessage || d.ResponseDescription || "Daraja STK Push failed",details:d});
    }

    await pool.query(`INSERT INTO mpesa_transactions
      (product_id,phone,amount,merchant_request_id,checkout_request_id,status)
      VALUES ($1,$2,$3,$4,$5,'pending')`,
      [productId,phone,amount,d.MerchantRequestID,d.CheckoutRequestID]);

    res.json({ok:true,checkoutRequestId:d.CheckoutRequestID,merchantRequestId:d.MerchantRequestID,responseDescription:d.ResponseDescription});
  }catch(e){
    console.error(e);
    res.status(500).json({error:e.message});
  }
});

app.get("/api/mpesa/status/:checkoutRequestId", async (req,res)=>{
  try{
    const {rows}=await pool.query(`SELECT status,result_code,result_desc,mpesa_receipt FROM mpesa_transactions WHERE checkout_request_id=$1`,[req.params.checkoutRequestId]);
    if(!rows.length) return res.status(404).json({status:"unknown"});
    const x=rows[0];
    res.json({status:x.status,resultCode:x.result_code,message:x.result_desc,receipt:x.mpesa_receipt});
  }catch(e){res.status(500).json({error:e.message});}
});

app.post("/api/mpesa/callback", async (req,res)=>{
  // Safaricom sends the payment result here. Only this server decides whether a download is unlocked.
  try{
    const cb=req.body?.Body?.stkCallback;
    if(!cb) return res.json({ResultCode:0,ResultDesc:"Accepted"});
    const checkout=cb.CheckoutRequestID;
    const code=Number(cb.ResultCode);
    let receipt=null, transactionDate=null;
    const items=cb.CallbackMetadata?.Item || [];
    for(const item of items){
      if(item.Name==="MpesaReceiptNumber") receipt=String(item.Value);
      if(item.Name==="TransactionDate") transactionDate=String(item.Value);
    }
    const status=code===0 ? "success" : "failed";
    await pool.query(`UPDATE mpesa_transactions SET status=$1,result_code=$2,result_desc=$3,mpesa_receipt=$4,transaction_date=$5,raw_callback=$6,updated_at=NOW() WHERE checkout_request_id=$7`,
      [status,code,cb.ResultDesc||null,receipt,transactionDate,req.body,checkout]);
    res.json({ResultCode:0,ResultDesc:"Accepted"});
  }catch(e){
    console.error(e);
    res.json({ResultCode:0,ResultDesc:"Accepted"});
  }
});

app.listen(PORT,()=>console.log(`Daraja backend running on port ${PORT}`));
