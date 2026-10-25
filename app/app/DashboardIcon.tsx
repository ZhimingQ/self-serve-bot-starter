/** Small, consistent stroke icons; no font glyph or third-party runtime needed. */
const paths: Record<string, string> = {
  assistant: "m12 3 2.4 6.6L21 12l-6.6 2.4L12 21l-2.4-6.6L3 12l6.6-2.4Z",
  channels: "M9 3v4m6-4v4M7 7h10v4a5 5 0 0 1-10 0Zm5 9v5",
  botTools: "m14 6 4 4m-8 3-7 7 1 1 7-7M14 3a6 6 0 0 0-5 9l3 3a6 6 0 0 0 9-5l-4 2-5-5Z",
  history: "M3 11a9 9 0 1 1 2 7M3 5v6h6m3-5v6l4 2",
  usage: "M4 20V10m6 10V4m6 16v-7m4 7H2",
  billing: "M3 6h18v13H3Zm0 4h18M6 15h4",
  modelKey: "M14 3a5 5 0 1 1-3 9L3 20v-4l7-7a5 5 0 0 1 4-6m2 4h.01",
  security: "m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6Z",
  account: "M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0M4 21v-2a8 8 0 0 1 16 0v2",
  privacy: "M7 10V7a5 5 0 0 1 10 0v3M5 10h14v11H5Zm7 4v3",
  support: "M9 9a3 3 0 1 1 5 2c-2 1-2 2-2 3m0 3h.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0",
  overview: "m3 10 9-7 9 7M5 9v12h14V9M9 21v-7h6v7",
  prompts: "M5 3h14v18H5Zm4 5h6m-6 4h6m-6 4h3",
  notifications: "M5 17h14l-2-3V9A5 5 0 0 0 7 9v5Zm5 3h4",
  settings: "M4 7h16M4 17h16M8 4v6m8 4v6",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  send: "M12 20V4m-6 6 6-6 6 6",
  arrow: "M4 12h16m-6-6 6 6-6 6",
};

export default function DashboardIcon({ name }: { name: string }) {
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d={paths[name] ?? paths.assistant} /></svg>;
}
