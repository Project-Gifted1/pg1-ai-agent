---
name: pdf-tools
description: Extract text and tables from PDF files. Use when the user gives you a PDF.
---

# PDF tools

To extract text, run the bundled script on the file the user gave you:

```bash
python scripts/extract_text.py input.pdf > output.txt
```

For tables, use `scripts/extract_tables.py`, which writes one CSV per table. Both scripts need `pdfplumber`; if it is missing, ask the user before installing it with `pip install pdfplumber`.

See reference.md for the full options and forms.md for filling in PDF forms.
