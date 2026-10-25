import Testing

@testable import EagleDesign

@Suite("Markdown blocks")
struct MarkdownTests {
  @Test("a paragraph then a list keeps the document order")
  func paragraphThenList() {
    let blocks = MarkdownBlock.parse("第一段\n- 一\n- 二\n第二段")
    #expect(
      blocks == [
        .paragraph("第一段"),
        .bullets(["一", "二"]),
        .paragraph("第二段"),
      ])
  }

  @Test("a longer fence keeps inner fences as code")
  func nestedFence() {
    let blocks = MarkdownBlock.parse("````md\n```swift\nlet x = 1\n```\n````")
    #expect(blocks == [.code(language: "md", body: "```swift\nlet x = 1\n```")])
  }

  @Test("numbered lists, headings and #include")
  func orderedAndHeadings() {
    #expect(MarkdownBlock.parse("1. 甲\n2) 乙") == [.bullets(["甲", "乙"])])
    #expect(MarkdownBlock.parse("## 标题") == [.heading(level: 2, text: "标题")])
    // `#include` is code, not a heading.
    #expect(MarkdownBlock.parse("#include <stdio.h>") == [.paragraph("#include <stdio.h>")])
    #expect(MarkdownBlock.parse("####### 七个井号") == [.paragraph("####### 七个井号")])
  }

  @Test("a heading needs a space and quotes render")
  func quotesAndEdges() {
    #expect(MarkdownBlock.parse("#标题") == [.paragraph("#标题")])
    #expect(MarkdownBlock.parse("> 引用") == [.quote("引用")])
    #expect(MarkdownBlock.parse("") == [])
  }
}
