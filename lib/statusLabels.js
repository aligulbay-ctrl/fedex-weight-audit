// Shared dispute-status enum so the dashboard <select>, the sort-by-status
// ordering (app/api/shipments/route.js), and the CSV export all agree on
// the same values/labels in one place.
//
// `color` keys into the CSS custom properties defined in globals.css
// (--status-<color> / --status-<color>-soft) - used to give each status its
// own tracking-number/row color in the dashboard table so rows are
// scannable by status at a glance.
export const DISPUTE_STATUSES = [
  { value: "none", label: "—", color: "neutral" },
  { value: "flagged", label: "İşaretlendi", color: "amber" },
  { value: "disputed", label: "İtiraz Edildi", color: "blue" },
  { value: "credit_note", label: "Fark Faturası Kesildi", color: "teal" },
  { value: "resolved", label: "Çözüldü", color: "green" },
];

export function disputeStatusLabel(value) {
  return DISPUTE_STATUSES.find((s) => s.value === value)?.label || value || "—";
}

export function disputeStatusColor(value) {
  return DISPUTE_STATUSES.find((s) => s.value === value)?.color || "neutral";
}
