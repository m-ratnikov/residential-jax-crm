/**
 * Named areas people actually say out loud, and the ZIPs they mean.
 *
 * Jacksonville has no published neighbourhood boundary in the county roll, so
 * "the Arlington area" has to become something the data can answer: a ZIP list.
 * Inventing a polygon would be inventing a boundary the county does not draw.
 *
 * This lived inside the criteria panel, which meant the map could answer
 * "distressed properties in Arlington" with 1,094 parcels while the agent -
 * asked the same question, in the assignment's own words - answered "none",
 * because it had never been told what Arlington was. It guessed
 * `address_city = 'Arlington'`, which cannot match: every ZIP here is
 * JACKSONVILLE on the roll.
 *
 * So it belongs where both readers can reach it, and the agent is handed it in
 * get_schema alongside the criteria presets.
 */
export interface NamedArea {
  id: string;
  label: string;
  zips: string[];
}

export const NEIGHBOURHOODS: NamedArea[] = [
  { id: "arlington", label: "Arlington", zips: ["32211", "32277", "32225"] },
  { id: "southside", label: "Southside", zips: ["32216", "32246", "32256"] },
  { id: "riverside", label: "Riverside and Avondale", zips: ["32204", "32205"] },
  { id: "northside", label: "Northside", zips: ["32208", "32209", "32218", "32219"] },
  { id: "westside", label: "Westside", zips: ["32210", "32221", "32244"] },
  { id: "beaches", label: "The Beaches", zips: ["32250", "32233", "32266"] },
  { id: "mandarin", label: "Mandarin and San Jose", zips: ["32217", "32223", "32257", "32258"] },
];

/** The ZIPs for a spoken area name, or null when it is not one we publish. */
export function zipsForArea(name: string): string[] | null {
  const needle = name.trim().toLowerCase();
  if (!needle) return null;
  const found = NEIGHBOURHOODS.find(
    (area) => area.id === needle || area.label.toLowerCase() === needle,
  );
  if (found) return [...found.zips];
  // "Arlington area", "the Beaches", "Riverside" against "Riverside and Avondale".
  const loose = NEIGHBOURHOODS.find(
    (area) =>
      needle.includes(area.id) ||
      area.label
        .toLowerCase()
        .split(" and ")
        .some((part) => needle.includes(part)),
  );
  return loose ? [...loose.zips] : null;
}
