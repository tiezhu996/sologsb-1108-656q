import type { DeveloperCategory, Dilution } from './developer'

export type PreparationStatus = '正常' | '已撤销'

export interface Preparation {
  id?: number
  stockSolutionId: number
  stockName: string
  category: DeveloperCategory
  developerId: number
  developerName: string
  dilution: Dilution
  targetVolumeMl: number
  stockVolumeMl: number
  preparedAt: string
  status: PreparationStatus
  revokedAt?: string
  schemaRev?: number
}
