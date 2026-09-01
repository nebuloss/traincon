/** Vite serves `?raw` imports as the file's text. */
declare module '*.svg?raw' {
  const content: string;
  export default content;
}
