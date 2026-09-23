// Non-JavaScript modules the Worker imports. Wrangler bundles .sql files as
// text by default.
declare module '*.sql' {
  const text: string;
  export default text;
}
