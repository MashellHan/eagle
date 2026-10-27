import Testing

@testable import EagleDesign
@testable import EagleFeatures

@Suite("Sidebar composition")
struct SidebarCompositionTests {
  private let bots = SidebarSection(id: "bots", title: "Bots", items: [])
  private let mock = [
    SidebarSection(id: "g1", title: "秘书处", items: []),
    SidebarSection(id: "g2", title: "新闻组", items: []),
  ]

  @Test("sample groups appear only when the reader asked for them")
  func mockToggle() {
    #expect(
      SidebarComposition.sections(botSections: [bots], mock: mock, showsMock: true).count == 3)
    #expect(
      SidebarComposition.sections(botSections: [bots], mock: mock, showsMock: false)
        == [bots])
  }

  @Test("real bots are always shown, even with no sample data")
  func botsAlways() {
    let sections = SidebarComposition.sections(botSections: [bots], mock: mock, showsMock: false)
    #expect(sections.first?.id == "bots")
    #expect(SidebarComposition.sections(botSections: [], mock: mock, showsMock: false).isEmpty)
  }

  @Test("a sample selection is dropped when sample data is switched off")
  func selection() {
    #expect(
      SidebarComposition.keepsSelection("g1-item", mockIDs: ["g1-item"], showsMock: false) == false)
    #expect(SidebarComposition.keepsSelection("g1-item", mockIDs: ["g1-item"], showsMock: true))
    #expect(SidebarComposition.keepsSelection("b_01", mockIDs: ["g1-item"], showsMock: false))
    #expect(SidebarComposition.keepsSelection(nil, mockIDs: ["g1-item"], showsMock: false) == false)
  }
}
