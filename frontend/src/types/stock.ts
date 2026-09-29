import type { DeveloperCategory, Dilution } from './developer'

/** 母液（浓缩液） */
export interface StockConcentrate {
  id?: number
  name: string
  category: DeveloperCategory
  /** 开封日期 YYYY-MM-DD */
  openedAt: string
  /** 失效日期 YYYY-MM-DD */
  expireDate: string
  /** 当前余量（mL） */
  volumeMl: number
  note?: string
  schemaRev?: number
}

export type MixRecordStatus = '正常' | '已撤销'

/** 分装配制台账：一条记录对应一次母液→工作液的配制（或撤销） */
export interface MixRecord {
  id?: number
  /** 配制批次号 */
  batchNo: string
  stockId: number
  stockName: string
  category: DeveloperCategory
  /** 生成的工作液 */
  workingDeveloperId: number
  workingName: string
  dilution: Dilution
  /** 目标工作液容量（mL） */
  targetVolumeMl: number
  /** 实际扣减的母液量（mL） */
  stockUsedMl: number
  /** 配制日期 YYYY-MM-DD */
  mixedAt: string
  status: MixRecordStatus
  /** 撤销日期 YYYY-MM-DD */
  revokedAt?: string
  schemaRev?: number
}

/** 配制业务校验失败，调用方据此提示且不写入任何数据 */
export class MixValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MixValidationError'
  }
}
