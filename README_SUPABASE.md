Migration instructions for Biz Eazy Invoicing

1) Export Google Sheets tabs as CSV files, name them:
   - invoices.csv
   - patrons.csv
   - employees.csv
   - payslips.csv

2) Install dependencies locally:
   npm install csv-parse

3) Set env vars in your shell (zsh):
   export GOOGLE_SHEETS_CSV_URL="https://path-to-your-csv-files"

4) Run migration:
   node migrations/migrate_from_sheets.js

5) Update frontend to use supabase-js (I will add client and example usage). See `src/supabaseClient.js` for an example.

Security note: Keep your data secure and never expose sensitive information in your client-side code.