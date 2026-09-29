import type { DeveloperCategory } from './developer'

export interface StockSolution {
  id?: number
  name: string
  category: DeveloperCategory
  openedAt: string
  expireDate: string
  volumeMl: number
  schemaRev?: number
}
