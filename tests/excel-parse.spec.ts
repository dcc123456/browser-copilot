import { describe, expect, it } from 'vitest'
import { parseSpreadsheet } from '../src/lib/workflow/excel-parse'
import { buildXlsx, buildZip, sheetXml } from './helpers/xlsx-fixture'

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'

function encode(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

describe('parseSpreadsheet · xlsx', () => {
  it('reads shared strings, numbers, booleans and empty cells', async () => {
    const bytes = buildXlsx({
      sheets: [
        {
          name: 'People',
          xml: sheetXml(
            '<row r="1">' +
              '<c r="A1" t="s"><v>0</v></c>' +
              '<c r="B1" t="s"><v>1</v></c>' +
              '<c r="C1" t="s"><v>2</v></c>' +
              '</row>' +
              '<row r="2">' +
              '<c r="A2" t="s"><v>3</v></c>' +
              '<c r="B2"><v>30</v></c>' +
              '<c r="C2" t="b"><v>1</v></c>' +
              '</row>' +
              '<row r="3">' +
              '<c r="A3" t="s"><v>4</v></c>' +
              '<c r="C3" t="b"><v>0</v></c>' +
              '</row>' +
              // A styled but valueless row must not become a data row.
              '<row r="4"><c r="A4" s="1"/></row>',
          ),
        },
      ],
      sharedStrings: ['Name', 'Age', 'Active', 'Alice', 'Bob'],
    })

    const parsed = await parseSpreadsheet(bytes, 'people.xlsx')
    expect(parsed.sheetName).toBe('People')
    expect(parsed.rawRows).toEqual([
      ['Name', 'Age', 'Active'],
      ['Alice', 30, true],
      ['Bob', null, false],
    ])
    expect(parsed.rows).toEqual([
      { Name: 'Alice', Age: 30, Active: true },
      { Name: 'Bob', Age: null, Active: false },
    ])
  })

  it('reads rich-text shared strings, inline strings and entities', async () => {
    const sharedStrings =
      XML_HEADER +
      '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<si><t>Hello</t></si>' +
      '<si><r><rPr><b/></rPr><t>ri</t></r><r><t>ch</t></r></si>' +
      '<si><t>A&amp;B</t></si>' +
      '</sst>'
    const bytes = buildXlsx({
      sheets: [
        {
          name: 'Strings',
          xml: sheetXml(
            '<row r="1">' +
              '<c r="A1" t="inlineStr"><is><t>Inline</t></is></c>' +
              '<c r="B1" t="s"><v>0</v></c>' +
              '</row>' +
              '<row r="2">' +
              '<c r="A2" t="s"><v>1</v></c>' +
              '<c r="B2" t="s"><v>2</v></c>' +
              '</row>',
          ),
        },
      ],
      sharedStrings,
    })

    const parsed = await parseSpreadsheet(bytes, 'strings.xlsx')
    expect(parsed.rows).toEqual([{ Inline: 'rich', Hello: 'A&B' }])
  })

  it('applies date/time styles and keeps unformatted serials numeric', async () => {
    const stylesXml =
      XML_HEADER +
      '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<numFmts count="2">' +
      '<numFmt numFmtId="164" formatCode="yyyy-mm-dd hh:mm:ss"/>' +
      '<numFmt numFmtId="165" formatCode="yyyy&quot;年&quot;m&quot;月&quot;d&quot;日&quot;"/>' +
      '</numFmts>' +
      '<cellXfs count="6">' +
      '<xf numFmtId="0"/>' +
      '<xf numFmtId="14"/>' +
      '<xf numFmtId="22"/>' +
      '<xf numFmtId="164"/>' +
      '<xf numFmtId="165"/>' +
      '<xf numFmtId="45"/>' +
      '</cellXfs></styleSheet>'
    const bytes = buildXlsx({
      sheets: [
        {
          name: 'Dates',
          xml: sheetXml(
            '<row r="1">' +
              ['DateOnly', 'DateTime', 'Custom', 'ChineseDate', 'Plain', 'TimeOnly']
                .map(
                  (label, index) =>
                    `<c r="${String.fromCharCode(65 + index)}1" t="inlineStr"><is><t>${label}</t></is></c>`,
                )
                .join('') +
              '</row>' +
              '<row r="2">' +
              '<c r="A2" s="1"><v>45000</v></c>' +
              '<c r="B2" s="2"><v>45000.5</v></c>' +
              '<c r="C2" s="3"><v>45000.25</v></c>' +
              '<c r="D2" s="4"><v>45000</v></c>' +
              '<c r="E2"><v>45000</v></c>' +
              '<c r="F2" s="5"><v>0.5</v></c>' +
              '</row>',
          ),
        },
      ],
      stylesXml,
    })

    const parsed = await parseSpreadsheet(bytes, 'dates.xlsx')
    const row = parsed.rows[0]!
    expect(row['DateOnly']).toBe('2023-03-15')
    expect(row['DateTime']).toBe('2023-03-15T12:00:00.000Z')
    expect(row['Custom']).toBe('2023-03-15T06:00:00.000Z')
    expect(row['ChineseDate']).toBe('2023-03-15')
    expect(row['Plain']).toBe(45000)
    expect(String(row['TimeOnly'])).toMatch(/T12:00:00\.000Z$/)
  })

  it('selects a sheet by name and lists available sheets when missing', async () => {
    const bytes = buildXlsx({
      sheets: [
        {
          name: 'First',
          xml: sheetXml('<row r="1"><c r="A1" t="inlineStr"><is><t>only</t></is></c></row>'),
        },
        {
          name: 'Summary',
          xml: sheetXml(
            '<row r="1"><c r="A1" t="inlineStr"><is><t>total</t></is></c></row>' +
              '<row r="2"><c r="A2"><v>7</v></c></row>',
          ),
        },
      ],
    })

    const parsed = await parseSpreadsheet(bytes, 'book.xlsx', { sheetName: 'Summary' })
    expect(parsed.sheetName).toBe('Summary')
    expect(parsed.rows).toEqual([{ total: 7 }])

    await expect(parseSpreadsheet(bytes, 'book.xlsx', { sheetName: 'Nope' })).rejects.toMatchObject(
      { code: 'EXCEL_SHEET_NOT_FOUND' },
    )
    await expect(parseSpreadsheet(bytes, 'book.xlsx', { sheetName: 'Nope' })).rejects.toThrow(
      /First.*Summary/,
    )
  })

  it('falls back to sheet1 when the workbook has no relationships', async () => {
    const bytes = buildZip({
      'xl/workbook.xml':
        XML_HEADER +
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        '<sheets><sheet name="Solo" sheetId="1"/></sheets></workbook>',
      'xl/worksheets/sheet1.xml': sheetXml(
        '<row r="1"><c r="A1" t="inlineStr"><is><t>value</t></is></c></row>',
      ),
    })

    const parsed = await parseSpreadsheet(bytes, 'solo.xlsx')
    expect(parsed.rows).toEqual([])
    expect(parsed.rawRows).toEqual([['value']])
  })

  it('reads stored (uncompressed) zip entries', async () => {
    const bytes = buildXlsx({
      sheets: [
        {
          name: 'Stored',
          xml: sheetXml('<row r="1"><c r="A1" t="inlineStr"><is><t>ok</t></is></c></row>'),
        },
      ],
      store: true,
    })
    const parsed = await parseSpreadsheet(bytes, 'stored.xlsx')
    expect(parsed.rawRows).toEqual([['ok']])
  })
})

describe('parseSpreadsheet · csv', () => {
  it('parses BOM, quotes, embedded delimiters and newlines', async () => {
    const csv =
      '\ufeffname,note\r\n' +
      '"Alice","hello, world"\r\n' +
      'Bob,"line1\nline2"\r\n' +
      'Carol,"say ""hi"""\r\n'
    const parsed = await parseSpreadsheet(encode(csv), 'people.csv')
    expect(parsed.sheetName).toBe('people')
    expect(parsed.rows).toEqual([
      { name: 'Alice', note: 'hello, world' },
      { name: 'Bob', note: 'line1\nline2' },
      { name: 'Carol', note: 'say "hi"' },
    ])
  })

  it('detects semicolon and tab delimiters', async () => {
    const semicolon = await parseSpreadsheet(encode('name;age\nAlice;30\n'), 'semi.csv')
    expect(semicolon.rows).toEqual([{ name: 'Alice', age: '30' }])

    const tab = await parseSpreadsheet(encode('name\tage\nAlice\t30\n'), 'tab.csv')
    expect(tab.rows).toEqual([{ name: 'Alice', age: '30' }])
  })

  it('derives column keys when the header has blanks and duplicates', async () => {
    const parsed = await parseSpreadsheet(encode('name,,name\nAlice,1,Bob\n'), 'dup.csv')
    expect(parsed.rows).toEqual([{ name: 'Alice', column2: '1', name_2: 'Bob' }])
  })

  it('adds column keys for data beyond the header width', async () => {
    const parsed = await parseSpreadsheet(encode('a,b\n1,2,3\n'), 'extra.csv')
    expect(parsed.rows).toEqual([{ a: '1', b: '2', column3: '3' }])
  })

  it('uses generated keys when hasHeader is false', async () => {
    const parsed = await parseSpreadsheet(encode('Alice,30\nBob,40\n'), 'no-header.csv', {
      hasHeader: false,
    })
    expect(parsed.rows).toEqual([
      { column1: 'Alice', column2: '30' },
      { column1: 'Bob', column2: '40' },
    ])
    expect(parsed.rawRows).toHaveLength(2)
  })

  it('skips empty lines and handles an empty file', async () => {
    const parsed = await parseSpreadsheet(encode('a,b\n\n1,2\n\n'), 'sparse.csv')
    expect(parsed.rows).toEqual([{ a: '1', b: '2' }])

    const empty = await parseSpreadsheet(encode(''), 'empty.csv')
    expect(empty.rows).toEqual([])
    expect(empty.rawRows).toEqual([])
  })

  it('returns no rows for a header-only file', async () => {
    const parsed = await parseSpreadsheet(encode('a,b\n'), 'header.csv')
    expect(parsed.rows).toEqual([])
    expect(parsed.rawRows).toEqual([['a', 'b']])
  })

  it('parses delimited text exported with an .xlsx name and strips repeated BOMs', async () => {
    // Real export: a job board wrote UTF-8 CSV (with two BOMs) as 邮箱信息.xlsx.
    const csv = '\ufeff\ufeff序号,职位名称\n1,前端\n2,后端\n'
    const parsed = await parseSpreadsheet(encode(csv), '邮箱信息.xlsx')
    expect(parsed.sheetName).toBe('邮箱信息')
    expect(parsed.rawRows).toEqual([
      ['序号', '职位名称'],
      ['1', '前端'],
      ['2', '后端'],
    ])
    expect(parsed.rows).toEqual([
      { 序号: '1', 职位名称: '前端' },
      { 序号: '2', 职位名称: '后端' },
    ])
  })
})

describe('parseSpreadsheet · errors', () => {
  it('rejects legacy .xls with a conversion hint', async () => {
    await expect(parseSpreadsheet(encode('not really xls'), 'old.xls')).rejects.toMatchObject({
      code: 'EXCEL_LEGACY_FORMAT_UNSUPPORTED',
    })
  })

  it('rejects OLE containers even when the extension is wrong', async () => {
    const ole = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0])
    await expect(parseSpreadsheet(ole, 'book.xlsx')).rejects.toMatchObject({
      code: 'EXCEL_LEGACY_FORMAT_UNSUPPORTED',
    })
  })

  it('rejects a truncated zip container', async () => {
    await expect(
      parseSpreadsheet(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0]), 'broken.xlsx'),
    ).rejects.toMatchObject({ code: 'EXCEL_PARSE_FAILED' })
  })

  it('rejects a zip without a workbook part', async () => {
    const bytes = buildZip({ 'xl/pictures/image.png': 'not a workbook' })
    await expect(parseSpreadsheet(bytes, 'fake.xlsx')).rejects.toThrow(/workbook\.xml/)
  })

  it('explains a non-zip, non-text .xlsx instead of blaming the zip container', async () => {
    const binary = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04])
    await expect(parseSpreadsheet(binary, 'broken.xlsx')).rejects.toThrow(
      /named \.xlsx but is neither a ZIP workbook nor readable text/,
    )
  })

  it('rejects unsupported file types', async () => {
    await expect(parseSpreadsheet(encode('%PDF-1.7'), 'notes.pdf')).rejects.toMatchObject({
      code: 'EXCEL_PARSE_FAILED',
    })
  })
})
