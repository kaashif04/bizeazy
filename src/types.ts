/**
 * Define data structures for the Custom Invoicing System.
 * Matches exactly with Google Sheets relational database schema.
 */

export interface Invoice {
  Invoice_ID: string;      // Primary Key
  Date: string;            // Format: YYYY-MM-DD
  Company: 'Bistro' | 'Nasi Kandar'; // Outlet slot selector
  Customer_Name: string;
  Customer_Type: 'Regular' | 'New';
  Status: 'Paid' | 'Pending';
  Total_Amount: number;
  Discount_Type?: 'percentage' | 'flat' | 'none';
  Discount_Value?: number;
  Subtotal_Amount?: number; // Pre-discount total
  Currency_Symbol?: string; // Custom chosen currency
  Is_Past_Entry?: boolean;  // Backdated flag
  Customer_Contact?: string;
  Customer_Address?: string; // Physical location/address for billing
  Template?: 'modern' | 'minimal' | 'bold' | 'classic';
  Notes?: string;
  Branch_Location?: string;
}

export interface InvoiceItem {
  Item_ID: string;         // Primary Key
  Invoice_ID: string;      // Foreign Key pointing to Invoice
  Item_Name: string;
  Quantity: number;
  Price: number;
  Subtotal: number;
}

export interface Customer {
  Customer_Name: string;   // Primary Key for profiling
  Contact: string;         // Customer contact number, email, or physical address
  Customer_Type: 'Regular' | 'New';
  Address?: string;        // Saved customer physical location address
  Branch_Location?: string;
}

export interface TemplateCustomization {
  primary_color: string;     // Primary brand accent color (hex)
  secondary_color: string;   // Secondary color/backgrounds
  text_dark: string;         // Primary dark text (hex)
  font_family: string;       // Custom font name
  title_size: string;        // 'text-base' | 'text-lg' | 'text-xl' | 'text-2xl' | 'text-3xl' | 'text-4xl'
  body_size: string;         // 'text-[10px]' | 'text-xs' | 'text-sm' | 'text-base'
  padding: string;           // 'p-4' | 'p-8' | 'p-12' | 'p-16'
  layout_order: 'logo-left' | 'logo-right' | 'logo-split' | 'stacked'; // Custom layout options to move around
  hide_payment_details: boolean;
  terms_footer: string;
}

export interface CompanyProfile {
  id: 'Bistro' | 'Nasi Kandar';
  name: string;
  company_name?: string;     // Corporate name (optional, e.g. "Culinary Holdings Group")
  store_name?: string;       // Specific store name (optional, e.g. "Bistro Georgetown Branch")
  subtitle?: string;          // Deprecated/Slogan (being removed)
  address: string;
  email: string;
  phone: string;
  currency_symbol: string;
  logo_url?: string;
  footer_text?: string;
  payment_info?: string;
  series_format?: string;
  template?: TemplateCustomization; // Per-outlet design — shared by Invoice & Quotation previews
}

export type OutletType = 'Bistro' | 'Nasi Kandar';

export interface Employee {
  Employee_ID: string;
  Employee_Name: string;
  IC_Passport: string;
  Position: string;
  Assigned_Outlet: 'Bistro' | 'Nasi Kandar';
  Basic_Salary: number;
  Bank_Details: string;
  Branch_Location: string;
  Citizenship?: 'Malaysian/PR' | 'Foreigner';
  Age?: number;
  Joining_Date?: string;        // ISO date string e.g. "2026-05-15"
}

export interface Payslip {
  Payslip_ID: string;
  Employee_ID: string;
  Issue_Date: string;
  Month_Year: string;
  Basic_Pay: number;
  Custom_Allowances: number;
  Total_Allowances: number;
  Employee_EPF: number;
  Employer_EPF: number;
  Employee_SOCSO: number;
  Employer_SOCSO: number;
  Employee_EIS: number;
  Employer_EIS: number;
  Total_Statutory_Deductions: number;
  Custom_Deductions: number;
  Final_Net_Pay: number;
  Branch_Location: string;
  Is_Saved: boolean;
  Allowances_JSON?: string;
  Deductions_JSON?: string;
  Payment_Transferred?: boolean;  // true once employer marks payment made
  Transfer_Date?: string;         // manually entered after payment e.g. "15 June 2026"
  Is_Payment_Due?: boolean;       // computed flag: month ended, payment not yet made
}

export type ServingStyle = 'Packed Bento Boxes' | 'Buffet Setup' | 'Dome Serving';
export type PricingMode = 'itemized' | 'package';
export type PackageSubMode = 'per_day' | 'flat_total';

export interface Quotation {
  Quotation_ID: string;
  Date: string;                          // issue date, YYYY-MM-DD
  Valid_Until?: string;                  // YYYY-MM-DD
  Company: 'Bistro' | 'Nasi Kandar';
  Customer_Name: string;
  Customer_Contact?: string;
  Customer_Address?: string;
  Pricing_Mode: PricingMode;
  Package_Sub_Mode?: PackageSubMode;     // only when Pricing_Mode === 'package'
  Flat_Package_Total?: number;           // only when Package_Sub_Mode === 'flat_total'
  Extra_Charges_JSON?: string;           // [{label, amount}] — service/delivery/custom, contract-level
  Discount_Type?: 'none' | 'percentage' | 'fixed';
  Discount_Value?: number;
  Subtotal_Amount?: number;
  Total_Amount: number;
  Catering_Terms?: string;               // deposit/cutoff T&Cs
  Notes?: string;
  Branch_Location?: string;
  Converted_Invoice_ID?: string;         // set once this quotation has been billed as a real invoice
}

export interface QuotationDay {
  Day_ID: string;
  Quotation_ID: string;                  // Foreign Key
  Event_Date: string;                    // YYYY-MM-DD — any date, any order
  Pax: number;
  Serving_Style: ServingStyle;
  Day_Package_Rate?: number;             // only used when package + per_day
}

export interface QuotationItem {
  Item_ID: string;
  Quotation_ID: string;                  // Foreign Key
  Day_ID: string;                        // Foreign Key -> QuotationDay
  Session_Label?: string;                // e.g. "Breakfast", "Lunch", "Dinner" — lets one day have multiple separately-menu'd sittings
  Session_Time?: string;                 // e.g. "7:30 AM"
  Item_Name: string;
  Quantity: number;
  Price: number;
  Subtotal: number;
}

export interface DatabaseState {
  invoices: Invoice[];
  invoice_items: InvoiceItem[];
  customers: Customer[];
  employees: Employee[];
  payslips: Payslip[];
  quotations: Quotation[];
  quotation_days: QuotationDay[];
  quotation_items: QuotationItem[];
}
