/** Questions asked in the admin's own sheet (window.prompt and confirm are unreliable in Telegram's webview). */
import { create } from 'zustand'

export interface AskOptions {
  placeholder?: string
  confirm?: string
  /** Prefilled answer */
  value?: string
  /** For a consequential action: the confirm button reads as a warning */
  danger?: boolean
  multiline?: boolean
  /** A yes/no question: no text box */
  confirmOnly?: boolean
  /** OK with an empty box answers '' (cancel still answers null) */
  optional?: boolean
}
export interface AskState {
  label: string | null
  options: AskOptions
  resolve: ((v: string | null) => void) | null
}
export const useAsk = create<AskState>(() => ({ label: null, options: {}, resolve: null }))

export function askText(label: string, options: AskOptions = {}): Promise<string | null> {
  // A second question replaces the first; the first is answered "cancel"
  useAsk.getState().resolve?.(null)
  return new Promise((resolve) => useAsk.setState({ label, options, resolve }))
}

/** Yes or no, in the same sheet (window.confirm is unreliable in Telegram too). */
export async function askConfirm(label: string, confirm = 'OK', danger = false): Promise<boolean> {
  return (await askText(label, { confirmOnly: true, confirm, danger, value: 'yes' })) !== null
}

