import SwiftUI

/// The assistant's turn inside a dialog bubble: rich text rendered from markdown — headings,
/// paragraphs, bullet and numbered lists, quotes, fenced code and tables — with inline
/// `**bold**`, `*italic*`, `` `code` `` chips and links. The card is the one surface a turn
/// gets; nothing here invents a second palette.
public struct AssistantBubble: View {
  private let text: String
  private let streaming: Bool
  @State private var caretVisible = true

  public init(text: String, streaming: Bool = false) {
    self.text = text
    self.streaming = streaming
  }

  public var body: some View {
    HStack(alignment: .bottom, spacing: 8) {
      VStack(alignment: .leading, spacing: 10) {
        let blocks = MarkdownBlock.parse(text)
        ForEach(Array(blocks.enumerated()), id: \.offset) { index, block in
          blockView(block, caret: streaming && index == blocks.count - 1)
        }
      }
      .padding(.horizontal, 16)
      .padding(.vertical, 13)
      .background(
        RoundedRectangle(cornerRadius: 20, style: .continuous)
          .fill(Theme.Palette.card)
      )
      .overlay(
        RoundedRectangle(cornerRadius: 20, style: .continuous)
          .strokeBorder(Theme.Palette.line, lineWidth: Theme.Metric.hairline)
      )
      .frame(maxWidth: Theme.Metric.conversationMaxContentWidth - 120, alignment: .leading)
      .animation(.easeOut(duration: 0.16), value: text)
      Spacer(minLength: 40)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .textSelection(.enabled)
    .onAppear {
      withAnimation(.easeInOut(duration: 0.62).repeatForever(autoreverses: true)) {
        caretVisible = false
      }
    }
  }

  @ViewBuilder
  private func blockView(_ block: MarkdownBlock, caret: Bool) -> some View {
    switch block {
    case .paragraph(let text):
      paragraph(text, caret: caret)
    case .heading(let level, let text):
      Text(inline(text))
        .font(.system(size: headingSize(level), weight: .semibold))
        .foregroundStyle(Theme.Palette.textPrimary)
        .lineSpacing(3)
        .fixedSize(horizontal: false, vertical: true)
    case .bullets(let items):
      VStack(alignment: .leading, spacing: 6) {
        ForEach(Array(items.enumerated()), id: \.offset) { index, item in
          HStack(alignment: .firstTextBaseline, spacing: 9) {
            Text("•")
              .font(Theme.TypeScale.body)
              .foregroundStyle(Theme.Palette.textSecondary)
              .frame(width: 8, alignment: .leading)
            if caret, index == items.count - 1 {
              Text(inline(item)) + caretMark
            } else {
              Text(inline(item))
            }
          }
          .font(Theme.TypeScale.body)
          .foregroundStyle(Theme.Palette.textPrimary)
          .lineSpacing(4)
          .fixedSize(horizontal: false, vertical: true)
        }
      }
    case .code(let language, let body):
      code(language: language, body: body, caret: caret)
    case .quote(let text):
      HStack(alignment: .top, spacing: 10) {
        RoundedRectangle(cornerRadius: 1.5)
          .fill(Theme.Palette.line)
          .frame(width: 3)
        VStack(alignment: .leading, spacing: 4) {
          ForEach(Array(text.components(separatedBy: "\n").enumerated()), id: \.offset) {
            _, line in
            Text(inline(line))
              .font(Theme.TypeScale.body)
              .foregroundStyle(Theme.Palette.textSecondary)
              .lineSpacing(4)
              .fixedSize(horizontal: false, vertical: true)
          }
        }
      }
    case .table(let headers, let rows):
      table(headers: headers, rows: rows, caret: caret)
    }
  }

  private func paragraph(_ text: String, caret: Bool) -> some View {
    Group {
      if caret {
        Text(inline(text)) + caretMark
      } else {
        Text(inline(text))
      }
    }
    .font(Theme.TypeScale.body)
    .foregroundStyle(Theme.Palette.textPrimary)
    .lineSpacing(5)
    .fixedSize(horizontal: false, vertical: true)
  }

  private func code(language: String?, body: String, caret: Bool) -> some View {
    VStack(alignment: .leading, spacing: 0) {
      if let language, !language.isEmpty {
        Text(language)
          .font(.system(size: 11, weight: .medium, design: .monospaced))
          .foregroundStyle(Theme.Palette.textMuted)
          .padding(.horizontal, 12)
          .padding(.top, 8)
      }
      ScrollView(.horizontal, showsIndicators: false) {
        Text(body)
          .font(.system(size: 12.5, design: .monospaced))
          .foregroundStyle(Theme.Palette.textPrimary)
          .textSelection(.enabled)
          .fixedSize(horizontal: true, vertical: true)
          .padding(.horizontal, 12)
          .padding(.vertical, 9)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(
      RoundedRectangle(cornerRadius: 10, style: .continuous)
        .fill(Theme.Palette.canvas)
    )
    .overlay(
      RoundedRectangle(cornerRadius: 10, style: .continuous)
        .strokeBorder(Theme.Palette.line, lineWidth: Theme.Metric.hairline)
    )
  }

  /// A grid, not raw pipes: header cells are dim and semibold, body cells wrap, and the
  /// whole table scrolls horizontally when a model writes many columns.
  private func table(headers: [String], rows: [[String]], caret: Bool) -> some View {
    ScrollView(.horizontal, showsIndicators: false) {
      Grid(alignment: .leading, horizontalSpacing: 18, verticalSpacing: 6) {
        GridRow {
          ForEach(Array(headers.enumerated()), id: \.offset) { _, header in
            Text(inline(header))
              .font(.system(size: 13, weight: .semibold))
              .foregroundStyle(Theme.Palette.textSecondary)
              .fixedSize(horizontal: false, vertical: true)
          }
        }
        Divider()
          .gridCellUnsizedAxes(.horizontal)
          .gridCellColumns(max(headers.count, 1))
        ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
          GridRow {
            ForEach(Array(row.enumerated()), id: \.offset) { _, cell in
              Text(inline(cell))
                .font(.system(size: 13.5))
                .foregroundStyle(Theme.Palette.textPrimary)
                .lineSpacing(3)
                .fixedSize(horizontal: false, vertical: true)
            }
          }
        }
      }
      .padding(.vertical, 2)
    }
  }

  private var caretMark: Text {
    Text("▍")
      .font(.system(size: 14, weight: .regular, design: .monospaced))
      .foregroundColor(Theme.Palette.accent.opacity(caretVisible ? 1 : 0.12))
  }

  private func headingSize(_ level: Int) -> CGFloat {
    switch level {
    case 1: return 20
    case 2: return 17
    default: return 15.5
    }
  }

  /// Inline markdown only: block structure is already handled above, so the parser must
  /// not re-interpret newlines. Code becomes a monospaced chip, strong/emphasis shape the
  /// weight, and links use the accent.
  private func inline(_ text: String) -> AttributedString {
    var value =
      (try? AttributedString(
        markdown: text,
        options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
      )) ?? AttributedString(text)
    for run in value.runs {
      let intent = run.inlinePresentationIntent
      var container = AttributeContainer()
      if intent?.contains(.code) == true {
        container.font = .system(size: 13, design: .monospaced)
        container.foregroundColor = Theme.Palette.textPrimary
        container.backgroundColor = Theme.Palette.canvas
      } else if intent?.contains(.stronglyEmphasized) == true {
        container.font = .system(size: 15, weight: .semibold)
      } else if intent?.contains(.emphasized) == true {
        container.font = .system(size: 15).italic()
      }
      if run.link != nil {
        container.foregroundColor = Theme.Palette.accent
      }
      value[run.range].mergeAttributes(container)
    }
    return value
  }
}

/// One block of a markdown document. Parsing is line based and deliberately small: fenced
/// code, headings, bullet and numbered lists, quotes, pipe tables and blank-line separated
/// paragraphs.
enum MarkdownBlock: Equatable {
  case paragraph(String)
  case heading(level: Int, text: String)
  case bullets([String])
  case code(language: String?, body: String)
  case quote(String)
  case table(headers: [String], rows: [[String]])

  /// `1. text` / `2) text` becomes a list item; the number is not rendered separately.
  private static func orderedItem(_ line: String) -> String? {
    var digits = 0
    for character in line {
      if character.isNumber {
        digits += 1
        continue
      }
      break
    }
    guard digits > 0, digits <= 3 else { return nil }
    let rest = line.dropFirst(digits)
    guard rest.hasPrefix(". ") || rest.hasPrefix(") ") else { return nil }
    return String(rest.dropFirst(2))
  }

  /// `| a | b |` split into trimmed cells; escaped pipes are not split.
  private static func tableCells(_ line: String) -> [String]? {
    let trimmed = line.trimmingCharacters(in: .whitespaces)
    guard trimmed.hasPrefix("|"), trimmed.count > 1 else { return nil }
    var cells: [String] = []
    var current = ""
    var escaped = false
    for character in trimmed.dropFirst() {
      if escaped {
        current.append(character == "|" ? "|" : character)
        escaped = false
        continue
      }
      if character == "\\" {
        escaped = true
        continue
      }
      if character == "|" {
        cells.append(current)
        current = ""
        continue
      }
      current.append(character)
    }
    cells.append(current)
    if cells.last?.trimmingCharacters(in: .whitespaces).isEmpty == true { cells.removeLast() }
    guard cells.count > 1 else { return nil }
    return cells.map { $0.trimmingCharacters(in: .whitespaces) }
  }

  /// `|---|:--:|` — every cell is a dash run with optional alignment colons.
  private static func tableDivider(_ line: String) -> Bool {
    guard let cells = tableCells(line), !cells.isEmpty else { return false }
    return cells.allSatisfy { cell in
      let body = cell.trimmingCharacters(in: CharacterSet(charactersIn: ":"))
      return !body.isEmpty && body.allSatisfy { $0 == "-" }
    }
  }

  static func parse(_ text: String) -> [MarkdownBlock] {
    var blocks: [MarkdownBlock] = []
    var paragraph: [String] = []
    var bullets: [String] = []
    var codeLines: [String] = []
    var codeLanguage: String?
    var codeFence = 0
    var inCode = false
    let lines = text.components(separatedBy: .newlines)
    var index = 0

    func flushParagraph() {
      if !paragraph.isEmpty {
        blocks.append(.paragraph(paragraph.joined(separator: "\n")))
        paragraph.removeAll()
      }
    }
    func flushBullets() {
      if !bullets.isEmpty {
        blocks.append(.bullets(bullets))
        bullets.removeAll()
      }
    }

    while index < lines.count {
      let rawLine = lines[index]
      index += 1
      let line = rawLine
      let trimmed = line.trimmingCharacters(in: .whitespaces)
      let fence = trimmed.prefix { $0 == "`" }.count
      if inCode {
        if fence >= codeFence, trimmed.allSatisfy({ $0 == "`" }) {
          blocks.append(.code(language: codeLanguage, body: codeLines.joined(separator: "\n")))
          codeLines.removeAll()
          codeLanguage = nil
          codeFence = 0
          inCode = false
        } else {
          codeLines.append(line)
        }
        continue
      }
      if fence >= 3 {
        flushParagraph()
        flushBullets()
        codeFence = fence
        codeLanguage = String(trimmed.dropFirst(fence)).trimmingCharacters(in: .whitespaces)
        inCode = true
        continue
      }
      if trimmed.isEmpty {
        flushParagraph()
        flushBullets()
        continue
      }
      // A table needs a header row followed by a divider; without one it is a paragraph.
      if let headers = tableCells(trimmed),
        index < lines.count,
        tableDivider(lines[index].trimmingCharacters(in: .whitespaces))
      {
        flushParagraph()
        flushBullets()
        index += 1
        var rows: [[String]] = []
        while index < lines.count {
          let next = lines[index].trimmingCharacters(in: .whitespaces)
          guard let cells = tableCells(next) else { break }
          rows.append(cells)
          index += 1
        }
        blocks.append(.table(headers: headers, rows: rows))
        continue
      }
      if trimmed.hasPrefix("#") {
        let hashes = trimmed.prefix { $0 == "#" }.count
        let rest = trimmed.dropFirst(hashes)
        if hashes <= 6, rest.hasPrefix(" ") {
          flushParagraph()
          flushBullets()
          blocks.append(.heading(level: hashes, text: rest.trimmingCharacters(in: .whitespaces)))
          continue
        }
      }
      if trimmed.hasPrefix("- ") || trimmed.hasPrefix("* ") || trimmed.hasPrefix("+ ") {
        flushParagraph()
        bullets.append(String(trimmed.dropFirst(2)))
        continue
      }
      if let ordered = orderedItem(trimmed) {
        flushParagraph()
        bullets.append(ordered)
        continue
      }
      if trimmed.hasPrefix("> ") {
        flushParagraph()
        flushBullets()
        var quoteLines = [String(trimmed.dropFirst(2))]
        while index < lines.count {
          let next = lines[index].trimmingCharacters(in: .whitespaces)
          guard next.hasPrefix("> ") else { break }
          quoteLines.append(String(next.dropFirst(2)))
          index += 1
        }
        blocks.append(.quote(quoteLines.joined(separator: "\n")))
        continue
      }
      flushBullets()
      paragraph.append(trimmed)
    }
    if inCode {
      blocks.append(.code(language: codeLanguage, body: codeLines.joined(separator: "\n")))
    }
    flushParagraph()
    flushBullets()
    return blocks
  }
}

extension Array where Element == AssistantTurn.Block {
  /// The demo transcript keeps structured blocks; the bubble renders their text as
  /// markdown paragraphs, lists and notes in one document.
  var markdown: String {
    map { block in
      switch block {
      case .paragraph(let text):
        return text
      case .bullets(let items):
        return items.map { "- " + $0 }.joined(separator: "\n")
      case .note(let text):
        return "> " + text
      }
    }.joined(separator: "\n\n")
  }
}
