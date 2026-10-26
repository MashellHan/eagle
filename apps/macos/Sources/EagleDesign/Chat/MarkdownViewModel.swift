import Combine
import SwiftUI

enum RenderedMarkdownBlock: Equatable, Sendable {
  case paragraph(AttributedString)
  case heading(level: Int, text: AttributedString)
  case bullets([AttributedString])
  case code(language: String?, body: String)
  case quote([AttributedString])
  case table(headers: [AttributedString], rows: [[AttributedString]])
}

actor MarkdownRenderer {
  func render(_ text: String) throws -> [RenderedMarkdownBlock] {
    try Task.checkCancellation()
    return try MarkdownBlock.parse(text).map { block in
      try Task.checkCancellation()
      switch block {
      case .paragraph(let value): return .paragraph(MarkdownDocument.inline(value))
      case .heading(let level, let value):
        return .heading(level: level, text: MarkdownDocument.inline(value))
      case .bullets(let items): return .bullets(items.map(MarkdownDocument.inline))
      case .code(let language, let body): return .code(language: language, body: body)
      case .quote(let value):
        return .quote(value.components(separatedBy: "\n").map(MarkdownDocument.inline))
      case .table(let headers, let rows):
        return .table(
          headers: headers.map(MarkdownDocument.inline),
          rows: rows.map { $0.map(MarkdownDocument.inline) }
        )
      }
    }
  }
}

@MainActor
final class MarkdownViewModel: ObservableObject {
  @Published private(set) var blocks: [RenderedMarkdownBlock] = []
  private static let renderer = MarkdownRenderer()
  private var renderedText: String?
  private var requestedText: String?

  func render(_ text: String) async {
    guard !Task.isCancelled else { return }
    requestedText = text
    guard renderedText != text else { return }
    guard let result = try? await Self.renderer.render(text),
      !Task.isCancelled, requestedText == text
    else { return }
    renderedText = text
    if blocks != result { blocks = result }
  }
}
