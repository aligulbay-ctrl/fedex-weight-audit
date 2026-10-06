# FedEx Invoice vs Shipment Report Audit

This Vercel dashboard compares FedEx invoice PDF billed weight with FedEx shipment report weight by tracking number.

Supported report files: CSV, XLS, XLSX.

The report unit controls the comparison unit. If the report is KG, invoice LB is converted to KG. If the report is LB, invoice KG is converted to LB. Original values are preserved.
