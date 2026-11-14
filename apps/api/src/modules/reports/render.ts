import type { ExportFormat } from '@attendsure/shared';
import { stringify } from 'csv-stringify/sync';
import PDFDocument from 'pdfkit';
import writeXlsxFile from 'write-excel-file/node';
import type { Cell, Report } from './report-builder.js';

export const EXPORT_MIME: Record<ExportFormat, string> = {
  CSV: 'text/csv',
  XLSX: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  PDF: 'application/pdf',
};
export const EXPORT_EXTENSION: Record<ExportFormat, string> = { CSV: 'csv', XLSX: 'xlsx', PDF: 'pdf' };

/** What the file says about itself: who made it, when, and whether it holds personal data. */
export interface Footer {
  generated: string;
  personal: boolean;
}

// Spreadsheet programs run a text cell starting with = + - @ (or a tab or carriage return) as a formula.
// Such cells get an apostrophe first (OWASP "CSV injection"). Numbers are written as numbers.
const FORMULA_START = /^[=+\-@\t\r]/;
export const safeText = (value: string) => (FORMULA_START.test(value) ? `'${value}` : value);
const text = (cell: Cell) => (cell === null ? '' : typeof cell === 'number' ? String(cell) : safeText(cell));

export async function render(report: Report, format: ExportFormat, footer: Footer): Promise<Buffer> {
  if (format === 'CSV') return renderCsv(report, footer);
  if (format === 'XLSX') return renderXlsx(report, footer);
  return renderPdf(report, footer);
}

function notice(footer: Footer) {
  return `${footer.generated}${footer.personal ? ' · Contains personal data: keep it safe and delete it when no longer needed (Data Protection Act, 2012).' : ''}`;
}

function renderCsv(report: Report, footer: Footer): Buffer {
  const lines = [
    [safeText(report.title)],
    [safeText(report.subtitle)],
    [safeText(notice(footer))],
    [],
    report.columns.map((c) => safeText(c.label)),
    ...report.rows.map((row) => row.map(text)),
  ];
  // A byte-order mark so spreadsheet programs read the file as UTF-8 (names with accents, "·").
  return Buffer.concat([Buffer.from('﻿', 'utf8'), Buffer.from(stringify(lines), 'utf8')]);
}

async function renderXlsx(report: Report, footer: Footer): Promise<Buffer> {
  const heading = (value: string, bold = false) => [
    { value: safeText(value), type: String, ...(bold ? { fontWeight: 'bold' as const } : {}) },
  ];
  const data = [
    heading(report.title, true),
    heading(report.subtitle),
    heading(notice(footer)),
    [],
    report.columns.map((c) => ({ value: safeText(c.label), type: String, fontWeight: 'bold' as const })),
    ...report.rows.map((row) =>
      row.map((cell) =>
        typeof cell === 'number' ? { value: cell, type: Number } : { value: text(cell), type: String },
      ),
    ),
  ];
  return writeXlsxFile(data as never, {
    sheet: 'Report',
    columns: report.columns.map((c) => ({ width: c.width ?? 14 })),
    stickyRowsCount: 5,
  }).toBuffer();
}

/** A plain table: title, subtitle, the columns repeated on every page, and a footer with page numbers. */
function renderPdf(report: Report, footer: Footer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      layout: report.wide ? 'landscape' : 'portrait',
      margins: { top: 40, bottom: 50, left: 36, right: 36 },
      bufferPages: true,
      info: { Title: report.title, Producer: 'AttendSure', Creator: 'AttendSure' },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const left = doc.page.margins.left;
    const usable = doc.page.width - left - doc.page.margins.right;
    const weights = report.columns.map((c) => c.width ?? 14);
    const total = weights.reduce((a, b) => a + b, 0);
    const widths = weights.map((w) => (w / total) * usable);
    const bottom = () => doc.page.height - doc.page.margins.bottom;
    const fontSize = report.columns.length > 14 ? 6.5 : report.columns.length > 9 ? 7.5 : 8.5;

    const row = (cells: string[], bold: boolean) => {
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(fontSize);
      const height = Math.max(...cells.map((c, i) => doc.heightOfString(c, { width: widths[i]! - 4 }))) + 6;
      if (doc.y + height > bottom()) {
        doc.addPage();
        header();
        doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(fontSize);
      }
      const y = doc.y;
      let x = left;
      cells.forEach((c, i) => {
        doc.text(c, x + 2, y + 3, { width: widths[i]! - 4, lineBreak: true });
        x += widths[i]!;
      });
      doc
        .moveTo(left, y + height)
        .lineTo(left + usable, y + height)
        .lineWidth(0.3)
        .strokeColor('#C9CFD8')
        .stroke();
      doc.x = left;
      doc.y = y + height;
    };
    const header = () =>
      row(
        report.columns.map((c) => c.label),
        true,
      );

    doc
      .font('Helvetica-Bold')
      .fontSize(14)
      .fillColor('#131820')
      .text(report.title, left, doc.y, { width: usable });
    doc.moveDown(0.3);
    doc.font('Helvetica').fontSize(9).fillColor('#465061').text(report.subtitle, { width: usable });
    doc.moveDown(0.8);
    doc.fillColor('#131820');
    header();
    if (report.rows.length === 0) {
      doc
        .font('Helvetica')
        .fontSize(fontSize)
        .text('Nothing to show.', left + 2, doc.y + 4);
    }
    for (const r of report.rows)
      row(
        r.map((c) => (c === null ? '' : String(c))),
        false,
      );

    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i);
      const y = doc.page.height - doc.page.margins.bottom + 16;
      // Writing inside the bottom margin would make pdfkit start a new page; lift the margin first.
      doc.page.margins.bottom = 0;
      doc
        .font('Helvetica')
        .fontSize(7)
        .fillColor('#5F6878')
        .text(`${notice(footer)}   Page ${i + 1} of ${range.count}`, left, y, {
          width: usable,
          lineBreak: false,
        });
    }
    doc.end();
  });
}
