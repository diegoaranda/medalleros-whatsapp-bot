const boliviaDateTime = new Intl.DateTimeFormat("es-BO", {
  dateStyle: "medium",
  timeStyle: "short",
  hourCycle: "h23",
  timeZone: "America/La_Paz"
});

/** Format the stored instant; never adjust or write the underlying timestamp. */
export function formatBoliviaDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  const instant = new Date(value);
  return Number.isFinite(instant.getTime()) ? boliviaDateTime.format(instant) : "—";
}
