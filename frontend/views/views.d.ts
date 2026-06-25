// Type declarations for view components to aid TypeScript module resolution
declare module "./views/InvoiceView" {
  import { InvoiceViewProps } from "../types";
  export const InvoiceView: React.FC<InvoiceViewProps>;
}

declare module "./views/InquiryView" {
  export const InquiryView: React.FC<any>;
}
