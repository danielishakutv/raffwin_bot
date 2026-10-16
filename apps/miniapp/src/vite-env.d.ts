/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_APP_ENV?: string
  readonly VITE_BOT_USERNAME?: string
  readonly VITE_ALLOW_BROWSER?: string
  readonly VITE_APP_VERSION?: string
  readonly VITE_BASE_PATH?: string
  readonly VITE_API_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
