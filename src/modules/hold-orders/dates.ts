// "Stop chasing until <date>": the picker gives a plain YYYY-MM-DD; we pause
// until the END of that day in New York (where the warehouse is), so "paying
// Wednesday" means nothing goes out on Wednesday itself. -04:00 is used all
// year: an hour of DST slop at the boundary costs nothing here (worst case
// the ladder resumes an hour late). Shared by finance's /api/orders route and
// Hold Orders.
export function endOfDayNewYork(ymd: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return null;
  const d = new Date(`${ymd}T23:59:00-04:00`);
  return Number.isFinite(d.getTime()) ? d : null;
}
