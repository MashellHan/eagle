import SwiftUI

/// One block of a markdown document. Parsing is line based and deliberately small: fenced
/// code, headings, bullet and numbered lists, quotes, pipe tables and blank-line separated
/// paragraphs.
enum MarkdownBlock: Equatable, Sendable {
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

struct MarkdownDocument {
  static func inline(_ text: String) -> AttributedString {
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
