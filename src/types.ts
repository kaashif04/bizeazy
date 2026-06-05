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
}

export interface DatabaseState {
  invoices: Invoice[];
  invoice_items: InvoiceItem[];
  customers: Customer[];
  employees: Employee[];
  payslips: Payslip[];
}
