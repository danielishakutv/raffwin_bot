import { create } from 'zustand'

export type ToastKind = 'info' | 'success' | 'error'

export interface ToastItem {
  id: number
  kind: ToastKind
  message: string
}

interface ToastState {
  items: ToastItem[]
  show: (message: string, kind?: ToastKind) => void
  dismiss: (id: number) => void
}

let counter = 0

export const useToast = create<ToastState>((set) => ({
  items: [],
  show(message, kind = 'info') {
    const id = (counter += 1)
    set((s) => ({ items: [...s.items.slice(-2), { id, kind, message }] }))
    window.setTimeout(() => set((s) => ({ items: s.items.filter((t) => t.id !== id) })), 3200)
  },
  dismiss(id) {
    set((s) => ({ items: s.items.filter((t) => t.id !== id) }))
  },
}))

/** Imperative helpers usable from anywhere (stores, async handlers). */
export const toast = {
  info: (m: string) => useToast.getState().show(m, 'info'),
  success: (m: string) => useToast.getState().show(m, 'success'),
  error: (m: string) => useToast.getState().show(m, 'error'),
}
