export type DeveloperCategory = 'D-76' | 'HC-110' | 'Rodinal' | 'C-41'
export type Dilution = '1:1' | '1:3'
export type DeveloperState = '新配' | '在用' | '报废' | '已撤销'
export type DeveloperSource = 'prepared' | 'legacy'

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
  /** prepared=由母液扣减配制生成；legacy=升级前已有数据，来源未追溯 */
  source?: DeveloperSource
  /** 配制时扣减的母液记录 id，legacy 数据为空 */
  stockSolutionId?: number
  /** 配制时实际扣减的母液体积（mL），撤销时按此回补 */
  stockVolumeMl?: number
  schemaRev?: number
}
