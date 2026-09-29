export type DeveloperCategory = 'D-76' | 'HC-110' | 'Rodinal' | 'C-41'
export type Dilution = '1:1' | '1:3'
export type DeveloperState = '新配' | '在用' | '报废' | '已撤销'

export interface Developer {
  id?: number
  name: string
  category: DeveloperCategory
  dilution: Dilution
  volumeMl: number
  mixedAt: string
  maxRolls: number
  usedRolls: number
  state: DeveloperState
  /** 来源母液 ID；由母液配制的工作液有值 */
  sourceStockId?: number
  /** 来源是否可追溯；升级前的旧数据为 false（来源未追溯，不补造母液） */
  sourceTraced: boolean
  schemaRev?: number
}
