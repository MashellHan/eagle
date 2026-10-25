import SwiftUI

/// The assistant's turn inside a dialog bubble: paragraphs, headings, bullet lists,
/// blockquotes and fenced code, with inline markdown (`**bold**`, `*italic*`, `` `code` ``)
/// rendered by the system parser. Nothing here invents a style: blocks reuse the
/// transcript's type scale and one card surface.
public struct AssistantBubble: View {
  private let text: String

  public init(text: String) {
    self.text = text
  }

  public var body: some View {
    HStack(alignment: .bottom, spacing: 8) {
      VStack(alignment: .leading, spacing: 8) {
        ForEach(Array(MarkdownBlock.parse(text).enumerated()), id: \.offset) { _, block in
          blockView(block)
        }
      }
      .padding(.horizontal, 14)
      .padding(.vertical, 10)
      .background(
        RoundedRectangle(cornerRadius: 16, style: .continuous)
          .fill(Theme.Palette.card)
      )
      .overlay(
        RoundedRectangle(cornerRadius: 16, style: .continuous)
          .strokeBorder(Theme.Palette.line, lineWidth: Theme.Metric.hairline)
      )
      .frame(maxWidth: Theme.Metric.conversationMaxContentWidth - 120, alignment: .leading)
      Spacer(minLength: 40)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .textSelection(.enabled)
  }

  @ViewBuilder
  private func blockView(_ block: MarkdownBlock) -> some View {
    switch block {
    case .paragraph(let text):
      Text(inline(text))
        .font(Theme.TypeScale.body)
        .foregroundStyle(Theme.Palette.textPrimary)
        .lineSpacing(3)
        .fixedSize(horizontal: false, vertical: true)
    case .heading(let level, let text):
      Text(inline(text))
        .font(.system(size: level <= 2 ? 17 : 15.5, weight: .semibold))
        .foregroundStyle(Theme.Palette.textPrimary)
        .fixedSize(horizontal: false, vertical: true)
    case .bullets(let items):
      VStack(alignment: .leading, spacing: 4) {
        ForEach(Array(items.enumerated()), id: \.offset) { _, item in
          HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text("•")
              .font(Theme.TypeScale.body)
              .foregroundStyle(Theme.Palette.textSecondary)
            Text(inline(item))
              .font(Theme.TypeScale.body)
              .foregroundStyle(Theme.Palette.textPrimary)
              .fixedSize(horizontal: false, vertical: true)
          }
        }
      }
    case .code(let language, let body):
      VStack(alignment: .leading, spacing: 4) {
        if let language, !language.isEmpty {
          Text(language)
            .font(.system(size: 11.5, weight: .medium, design: .monospaced))
            .foregroundStyle(Theme.Palette.textMuted)
        }
        Text(body)
          .font(Theme.TypeScale.mono)
          .foregroundStyle(Theme.Palette.textPrimary)
          .textSelection(.enabled)
          .fixedSize(horizontal: false, vertical: true)
      }
      .padding(10)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(
        RoundedRectangle(cornerRadius: 8, style: .continuous)
          .fill(Theme.Palette.canvas)
      )
    case .quote(let text):
      HStack(alignment: .top, spacing: 8) {
        RoundedRectangle(cornerRadius: 1)
          .fill(Theme.Palette.line)
          .frame(width: 3)
        Text(inline(text))
          .font(Theme.TypeScale.body)
          .foregroundStyle(Theme.Palette.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
  }

  /// Inline markdown only: block structure is already handled above, so the parser must
  /// not re-interpret newlines.
  private func inline(_ text: String) -> AttributedString {
    (try? AttributedString(
      markdown: text,
      options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
    )) ?? AttributedString(text)
  }
}

/// One block of a markdown document. Parsing is line based and deliberately small: fenced
/// code, headings, bullets, quotes and blank-line separated paragraphs.
enum MarkdownBlock: Equatable {
  case paragraph(String)
  case heading(level: Int, text: String)
  case bullets([String])
  case code(language: String?, body: String)
  case quote(String)

  static func parse(_ text: String) -> [MarkdownBlock] {
    var blocks: [MarkdownBlock] = []
    var paragraph: [String] = []
    var bullets: [String] = []
    var codeLines: [String] = []
    var codeLanguage: String?
    var inCode = false

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

    for rawLine in text.components(separatedBy: .newlines) {
      let line = rawLine
      let trimmed = line.trimmingCharacters(in: .whitespaces)
      if trimmed.hasPrefix("```") {
        if inCode {
          blocks.append(.code(language: codeLanguage, body: codeLines.joined(separator: "\n")))
          codeLines.removeAll()
          codeLanguage = nil
          inCode = false
        } else {
          flushParagraph()
          flushBullets()
          codeLanguage = String(trimmed.dropFirst(3)).trimmingCharacters(in: .whitespaces)
          inCode = true
        }
        continue
      }
      if inCode {
        codeLines.append(line)
        continue
      }
      if trimmed.isEmpty {
        flushParagraph()
        flushBullets()
        continue
      }
      if trimmed.hasPrefix("#") {
        flushParagraph()
        flushBullets()
        let hashes = trimmed.prefix { $0 == "#" }.count
        let heading = trimmed.dropFirst(hashes).trimmingCharacters(in: .whitespaces)
        blocks.append(.heading(level: hashes, text: heading))
        continue
      }
      if trimmed.hasPrefix("- ") || trimmed.hasPrefix("* ") || trimmed.hasPrefix("+ ") {
        flushParagraph()
        bullets.append(String(trimmed.dropFirst(2)))
        continue
      }
      if trimmed.hasPrefix("> ") {
        flushParagraph()
        flushBullets()
        blocks.append(.quote(String(trimmed.dropFirst(2))))
        continue
      }
      if bullets.isEmpty {
        flushBullets()
      }
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
