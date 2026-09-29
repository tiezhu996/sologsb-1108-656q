import { defineStore } from 'pinia'
import { db, plain, SCHEMA_REV } from '../utils/db'
import { calculateStockVolume, estimateRolls } from '../utils/ratio'
import { isExpired, today } from '../utils/date'
import type { StockConcentrate, MixRecord, MixRecordStatus } from '../types/stock'
import { MixValidationError } from '../types/stock'
import type { Developer, DeveloperCategory, Dilution } from '../types/developer'

export interface MixInput {
  /** 工作液类别，必须与所选母液类别一致 */
  category: DeveloperCategory
  stockId: number
  workingName: string
  dilution: Dilution
  targetVolumeMl: number
  mixedAt: string
}

export interface RevokeResult {
  restoredMl: number
}

type NewStock = Omit<StockConcentrate, 'id' | 'schemaRev'>

export const useStockStore = defineStore('stock', {
  state: () => ({
    stocks: [] as StockConcentrate[],
    mixes: [] as MixRecord[],
    loading: false
  }),
  getters: {
    /** 按类别、未过期且有余量的可选母液 */
    usableStocks: (state) => (category: DeveloperCategory) =>
      state.stocks.filter((stock) => stock.category === category && stock.volumeMl > 0 && !isExpired(stock.expireDate)),
    activeMixes: (state) => state.mixes.filter((mix) => mix.status === '正常'),
    revokedMixes: (state) => state.mixes.filter((mix) => mix.status === '已撤销')
  },
  actions: {
    async load(): Promise<void> {
      this.loading = true
      try {
        const [stocks, mixes] = await Promise.all([
          db.stocks.orderBy('id').reverse().toArray(),
          db.mixes.orderBy('id').reverse().toArray()
        ])
        this.stocks = stocks
        this.mixes = mixes
      } finally {
        this.loading = false
      }
    },

    async registerStock(payload: NewStock): Promise<number> {
      const next = { ...payload, schemaRev: SCHEMA_REV }
      const id = await db.stocks.add(plain(next))
      await this.load()
      return id
    },

    /**
     * 由母液调工作液。
     * 校验：母液存在、类别相符、未过期、余量充足；任一不通过抛 MixValidationError，不写入任何数据。
     * 通过后在单个事务内：扣减母液余量、生成工作液、写入台账记录。
     */
    async mixWorking(input: MixInput): Promise<{ mixId: number; developerId: number; stockUsedMl: number }> {
      const workingName = input.workingName.trim()
      const targetVolumeMl = Math.round(input.targetVolumeMl)
      if (!workingName) throw new MixValidationError('请填写工作液名称')
      if (!Number.isFinite(targetVolumeMl) || targetVolumeMl <= 0) {
        throw new MixValidationError('目标容量必须大于 0')
      }
      if (!input.mixedAt) throw new MixValidationError('请选择配制日期')

      const requiredMl = calculateStockVolume(targetVolumeMl, input.dilution)
      // 以配制日期判断是否过期；补录过去日期时若今天已过期同样拒绝
      const referenceDate = input.mixedAt < today() ? today() : input.mixedAt

      let mixId = 0
      let developerId = 0
      let stockUsedMl = 0

      await db.transaction('rw', [db.stocks, db.developers, db.mixes], async () => {
        const stock = await db.stocks.get(input.stockId)
        if (!stock) throw new MixValidationError('所选母液不存在，无法配制')
        if (stock.category !== input.category) {
          throw new MixValidationError(`类别不符：母液「${stock.name}」是 ${stock.category}，不能配制 ${input.category} 工作液`)
        }
        if (isExpired(stock.expireDate, referenceDate)) {
          throw new MixValidationError(`母液「${stock.name}」已于 ${stock.expireDate} 过期，拒绝配制`)
        }
        if (stock.volumeMl < requiredMl) {
          throw new MixValidationError(
            `母液「${stock.name}」余量不足：需要 ${requiredMl} mL，仅剩 ${stock.volumeMl} mL`
          )
        }

        await db.stocks.update(stock.id!, plain({ volumeMl: stock.volumeMl - requiredMl }))

        const developer: Developer = {
          name: workingName,
          category: stock.category,
          dilution: input.dilution,
          volumeMl: targetVolumeMl,
          mixedAt: input.mixedAt,
          maxRolls: Math.max(1, estimateRolls(targetVolumeMl)),
          usedRolls: 0,
          state: '新配',
          sourceStockId: stock.id!,
          sourceTraced: true,
          schemaRev: SCHEMA_REV
        }
        developerId = await db.developers.add(plain(developer))

        const count = await db.mixes.count()
        const mix: MixRecord = {
          batchNo: `M-${input.mixedAt.replace(/-/g, '')}-${String(count + 1).padStart(2, '0')}`,
          stockId: stock.id!,
          stockName: stock.name,
          category: stock.category,
          workingDeveloperId: developerId,
          workingName,
          dilution: input.dilution,
          targetVolumeMl,
          stockUsedMl: requiredMl,
          mixedAt: input.mixedAt,
          status: '正常',
          schemaRev: SCHEMA_REV
        }
        mixId = await db.mixes.add(plain(mix))
        stockUsedMl = requiredMl
      })

      await this.load()
      return { mixId, developerId, stockUsedMl }
    },

    /**
     * 撤销一条未冲洗的配制记录。
     * 已冲洗（usedRolls > 0）或已报废的工作液直接拒绝，不做任何改动。
     * 撤销在单事务内恢复母液余量、作废工作液、台账留痕；
     * 任一步失败都会整体回滚（含已恢复的母液余量），记录保持原状、不留“已撤销”。
     */
    async revokeMix(mixId: number): Promise<RevokeResult> {
      const referenceDate = today()
      try {
        let restoredMl = 0
        await db.transaction('rw', [db.stocks, db.developers, db.mixes], async () => {
          const mix = await db.mixes.get(mixId)
          if (!mix) throw new MixValidationError('台账记录不存在')
          if (mix.status === '已撤销') throw new MixValidationError('该配制记录已经撤销过')

          const working = await db.developers.get(mix.workingDeveloperId)
          if (!working) throw new MixValidationError('对应的工作液已不存在，无法撤销')
          if ((working.usedRolls ?? 0) > 0) {
            throw new MixValidationError(`工作液「${working.name}」已冲洗 ${working.usedRolls} 卷，不能撤销`)
          }
          if (working.state === '报废') {
            throw new MixValidationError(`工作液「${working.name}」已报废，不能撤销`)
          }

          const stock = await db.stocks.get(mix.stockId)
          if (!stock) throw new MixValidationError('来源母液已不在册，无法回退余量')

          const mixUpdated = await db.mixes.update(
            mixId,
            plain({ status: '已撤销' as MixRecordStatus, revokedAt: referenceDate })
          )
          if (mixUpdated === 0) throw new MixValidationError('台账记录更新失败，已回滚')

          const stockUpdated = await db.stocks.update(
            stock.id!,
            plain({ volumeMl: stock.volumeMl + mix.stockUsedMl })
          )
          if (stockUpdated === 0) throw new MixValidationError('母液余量恢复失败，已回滚')

          const devUpdated = await db.developers.update(
            mix.workingDeveloperId,
            plain({ state: '已撤销' })
          )
          if (devUpdated === 0) throw new MixValidationError('工作液作废失败，已回滚')

          restoredMl = mix.stockUsedMl
        })
        await this.load()
        return { restoredMl }
      } catch (error) {
        // 事务已整体回滚：母液余量不变，记录保持原状
        await this.load()
        throw error
      }
    }
  }
})
