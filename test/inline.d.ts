// Vite's `?inline` import of a file: its content as a data URL.
declare module "*?inline" {
  const dataUrl: string;
  export default dataUrl;
}
