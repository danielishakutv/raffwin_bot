/**
 * Telegram HTML (parse_mode HTML) helpers. Anything a person typed (names,
 * admin messages) goes through escapeHtml before it is put inside markup.
 */

/** Escapes the characters Telegram's HTML parser treats as markup. */
export function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/**
 * What to call a player in a message: their Telegram first name, else the
 * first word of the name they gave, else "there". Plain text: escape it
 * before putting it into HTML.
 */
export function firstName(user: { tgFirstName?: string | null; fullName?: string | null }): string {
  const tg = user.tgFirstName?.trim()
  if (tg) return tg
  const given = user.fullName?.trim().split(/\s+/)[0]
  return given || 'there'
}
