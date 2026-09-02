import puppeteer from 'puppeteer-core';
import chromium from '@sparticuz/chromium';

export async function generateCleanPDF(htmlContent) {
  // 1. Sanitize ASCII borders (strips terminal boxes to prevent %%%%% encoding glitches)
  const sanitizedContent = htmlContent.replace(/[┌│└─┐┘├┤┬┴┼]/g, '');

  // 2. Inject forced light-mode CSS to prevent the black void background
  const printReadyHTML = `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        @media print {
          body {
            background-color: #ffffff !important;
            color: #000000 !important;
            -webkit-print-color-adjust: exact;
          }
          pre, code, .box-container {
            background-color: #f3f4f6 !important;
            color: #111827 !important;
            border: 1px solid #e5e7eb !important;
            white-space: pre-wrap !important;
            word-break: break-word !important;
          }
        }
      </style>
    </head>
    <body class="pdf-container">
      ${sanitizedContent}
    </body>
    </html>
  `;

  // 3. Launch Vercel-optimized headless Chromium browser
  const browser = await puppeteer.launch({
    args: chromium.args,
    defaultViewport: chromium.defaultViewport,
    executablePath: await chromium.executablePath(),
    headless: chromium.headless,
  });
  
  const page = await browser.newPage();
  await page.setContent(printReadyHTML, { waitUntil: 'networkidle0' });
  
  // 4. Force the browser to render using the @media print styles
  await page.emulateMediaType('print'); 

  const pdfBuffer = await page.pdf({
    format: 'A4',
    printBackground: true,
    margin: { top: '1cm', right: '1cm', bottom: '1cm', left: '1cm' }
  });

  await browser.close();
  return pdfBuffer;
}
