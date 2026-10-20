/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Where the Aftershock API runs. Leave it out: the default, /api, is the same server. */
  readonly VITE_API_URL?: string;
  /** Where the footer's Documentation link points; defaults to the API's /redoc page */
  readonly VITE_DOCS_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
