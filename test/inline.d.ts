// Vite's `?inline` import of a file: its content as a data URL.
declare module "*?inline" {
  const dataUrl: string;
  export default dataUrl;
}

// Vite's `?raw` import of a file: its content as text.
declare module "*?raw" {
  const text: string;
  export default text;
}
