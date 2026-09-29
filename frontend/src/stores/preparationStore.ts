import { defineStore } from 'pinia'
import { db, plain } from '../utils/db'
import type { Developer, DeveloperCategory, Dilution } from '../types/developer'
import type { Preparation } from '../types/preparation'
import { calculateStockVolume } from '../utils/ratio'
import { isStockExpired } from './stockStore'

export interface PreparePayload {
  stockSolutionId: number
  category: DeveloperCategory
  name: string
  dilution: Dilution
  targetVolumeMl: number
  maxRolls: number
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

export const usePreparationStore = defineStore('preparation', {
  state: () => ({
    preparations: [] as Preparation[],
    loading: false
  }),
  getters: {
    activePreparations: (state) => state.preparations.filter((item) => item.status === '正常')
  },
  actions: {
    async load(): Promise<void> {
      this.loading = true
      try {
        this.preparations = await db.preparations.orderBy('id').reverse().toArray()
      } finally {
        this.loading = false
      }
    },

    /**
     * 用母液配制工作液。
     * 事务内依次校验：母液存在、类别一致、未过期、余量充足；
     * 任一校验失败则整体回滚，不写入任何表。
     * 成功后扣减母液余量、生成工作液与一条配制台账。
     */
    async prepare(payload: PreparePayload): Promise<{ developerId: number; preparationId: number }> {
      const { stockSolutionId, category, name, dilution, targetVolumeMl, maxRolls } = payload
      const preparedAt = today()
      const stockVolumeMl = calculateStockVolume(targetVolumeMl, dilution)

      return db.transaction('rw', db.stockSolutions, db.developers, db.preparations, async () => {
        const stock = await db.stockSolutions.get(stockSolutionId)
        if (!stock || stock.id === undefined) {
          throw new Error('母液不存在或已删除，拒绝配制')
        }
        if (stock.category !== category) {
          throw new Error(`母液类别（${stock.category}）与工作液类别（${category}）不符，拒绝写入`)
        }
        if (isStockExpired(stock.expireDate)) {
          throw new Error(`母液已于 ${stock.expireDate} 过期，拒绝配制`)
        }
        if (stockVolumeMl > stock.volumeMl) {
          throw new Error(`母液余量不足：本次需 ${stockVolumeMl} mL，当前仅余 ${stock.volumeMl} mL，拒绝写入`)
        }

        await db.stockSolutions.update(stock.id, plain({
          volumeMl: stock.volumeMl - stockVolumeMl
        }))

        const developer: Developer = {
          name,
          category,
          dilution,
          volumeMl: targetVolumeMl,
          mixedAt: preparedAt,
          maxRolls,
          usedRolls: 0,
          state: '新配',
          source: 'prepared',
          stockSolutionId: stock.id,
          stockVolumeMl,
          schemaRev: 3
        }
        const developerId = await db.developers.add(plain(developer))

        const preparation: Preparation = {
          stockSolutionId: stock.id,
          stockName: stock.name,
          category,
          developerId,
          developerName: name,
          dilution,
          targetVolumeMl,
          stockVolumeMl,
          preparedAt,
          status: '正常',
          schemaRev: 3
        }
        const preparationId = await db.preparations.add(plain(preparation))
        return { developerId, preparationId }
      })
    },

    /**
     * 撤销一条配制。已冲洗（usedRolls > 0）的工作液不能撤销。
     * 未冲洗的在事务内回补母液余量、工作液标记「已撤销」，
     * 配制记录保留并置为「已撤销」；任一步失败则整体回滚。
     */
    async revoke(developerId: number): Promise<void> {
      const revokedAt = today()
      await db.transaction('rw', db.developers, db.stockSolutions, db.preparations, async () => {
        const developer = await db.developers.get(developerId)
        if (!developer) throw new Error('工作液不存在')
        if (developer.state === '已撤销') throw new Error('该工作液已撤销，请勿重复操作')
        if (developer.state === '报废') throw new Error('已报废的工作液不能撤销')
        if (developer.usedRolls > 0) {
          throw new Error('已冲洗的工作液不能撤销')
        }

        if (developer.source === 'prepared' && developer.stockSolutionId !== undefined) {
          const stock = await db.stockSolutions.get(developer.stockSolutionId)
          if (!stock) throw new Error('母液记录不存在，无法恢复余量，本次撤销已回滚')
          await db.stockSolutions.update(stock.id!, plain({
            volumeMl: stock.volumeMl + (developer.stockVolumeMl ?? 0)
          }))
        }

        await db.developers.update(developerId, plain({ state: '已撤销' }))
        const preparation = await db.preparations.where('developerId').equals(developerId).first()
        if (preparation && preparation.id !== undefined) {
          await db.preparations.update(preparation.id, plain({ status: '已撤销', revokedAt }))
        }
      })
    }
  }
})
