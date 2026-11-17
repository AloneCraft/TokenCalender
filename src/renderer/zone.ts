/** IANA タイムゾーン名として使えるか（ブラウザーの Intl で確かめる） */
export function isValidZoneName(z: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: z });
    return true;
  } catch {
    return false;
  }
}
