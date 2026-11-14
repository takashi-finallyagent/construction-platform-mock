// IDs correspond to section 7 of product-classification-design.md.
export const CLASSIFICATION_SOURCES: Record<string, { label: string; url: string }> = {
  L01: { label: '国交省：許可事務ガイドライン', url: 'https://www.mlit.go.jp/totikensangyo/const/content/001860019.pdf' },
  L02: { label: '国交省：業種区分一覧', url: 'https://www.mlit.go.jp/common/001209751.pdf' },
  L03: { label: '国交省：建設業の許可とは', url: 'https://www.mlit.go.jp/totikensangyo/const/1_6_bt_000080.html' },
  L04: { label: '国交省：法令遵守ガイドライン', url: 'https://www.mlit.go.jp/totikensangyo/const/1_6_bt_000188.html' },
  L05: { label: '国交省：標準約款', url: 'https://www.mlit.go.jp/totikensangyo/const/1_6_bt_000092.html' },
  L06: { label: '経産省：電気工事業の手続', url: 'https://www.safety-kanto.meti.go.jp/electric/kojigyo/index.html' },
  L07: { label: '厚労省：石綿・小規模工事の手続', url: 'https://www.ishiwata.mhlw.go.jp/procedures/' },
  L08: { label: '環境省：建設リサイクル法の概要', url: 'https://www.env.go.jp/recycle/build/gaiyo.html' },
  L09: { label: '国交省：建築確認対象の見直し', url: 'https://www.mlit.go.jp/jutakukentiku/build/content/001902550.pdf' },
  WASTE: { label: '環境省：排出事業者責任', url: 'https://www.env.go.jp/recycle/waste/haisyutsu.html' },
}
