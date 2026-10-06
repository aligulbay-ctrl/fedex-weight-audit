import pdf from "pdf-parse";
const pnum=s=>s==null?null:Number(String(s).replace(",","."));
const unit=u=>String(u||"").toUpperCase().replace("LBS","LB").replace("KGS","KG");
const money=s=>s==null?null:Number(String(s).replace(/\./g,"").replace(",","."));
export async function extractInvoiceShipments(buffer,fileName="invoice.pdf"){
 const parsed=await pdf(buffer); const text=String(parsed.text||"").replace(/\u00a0/g," ").replace(/\r/g,"\n");
 const invoiceNo=text.match(/Fatura\s*No[:\s]+([A-Z0-9-]+)/i)?.[1]||text.match(/Invoice\s*(?:No|Number)[:\s]+([A-Z0-9-]+)/i)?.[1]||fileName;
 const matches=[...text.matchAll(/\b(\d{12})\b/g)], rows=[];
 for(let i=0;i<matches.length;i++){const trackingNumber=matches[i][1],block=text.slice(matches[i].index,i+1<matches.length?matches[i+1].index:text.length);
  const m=[...block.matchAll(/(?<!\d)(\d{1,3}(?:[.,]\d+)?)(?!\d)\s*(KG|KGS|LB|LBS)\b[\s\S]{0,80}?(\d{1,3}(?:\.\d{3})*,\d{2}|\d+,\d{2})\s*TL\b/gi)].at(-1);
  rows.push({invoiceNo,fileName,trackingNumber,invoiceWeight:m?pnum(m[1]):null,invoiceUnit:m?unit(m[2]):null,amountTl:m?money(m[3]):null});
 }
 return Array.from(new Map(rows.map(r=>[r.trackingNumber,r])).values());
}