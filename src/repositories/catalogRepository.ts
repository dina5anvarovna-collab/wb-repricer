import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";

export type CatalogListQuery = {
  search?: string;
  evaluationStatus?: string;
  brand?: string;
  /** Точное совпадение бренда (из справочника) */
  brandExact?: boolean;
  /** Остаток на складе WB (поле stock; часто пустое, пока не подтянуто из API) */
  stock?: "with" | "without";
  controlEnabled?: boolean;
  belowMin?: boolean;
  parseFailed?: boolean;
  /** true = только с buyerParseEnabled, false = только отключённые от парсинга */
  buyerParseEnabled?: boolean;
  limit: number;
  offset: number;
  sortBy: "nmId" | "title" | "updatedAt" | "lastMonitorAt";
  sortDir: "asc" | "desc";
};

function buildWhere(q: CatalogListQuery): Prisma.WbProductWhereInput {
  const and: Prisma.WbProductWhereInput[] = [];
  if (q.search?.trim()) {
    const s = q.search.trim();
    const n = Number(s);
    const or: Prisma.WbProductWhereInput[] = [
      { title: { contains: s } },
      { vendorCode: { contains: s } },
      { brand: { contains: s } },
      { subjectName: { contains: s } },
    ];
    if (Number.isFinite(n) && n > 0) {
      or.push({ nmId: n });
    }
    and.push({ OR: or });
  }
  if (q.brand?.trim()) {
    const b = q.brand.trim();
    if (q.brandExact) {
      and.push({ brand: b });
    } else {
      and.push({ brand: { contains: b } });
    }
  }
  if (q.stock === "with") {
    and.push({ stock: { gt: 0 } });
  }
  if (q.stock === "without") {
    and.push({
      OR: [{ stock: null }, { stock: { lte: 0 } }],
    });
  }
  if (q.evaluationStatus?.trim()) {
    and.push({ lastEvaluationStatus: q.evaluationStatus.trim() });
  }
  if (q.controlEnabled === true) {
    and.push({ minPriceRule: { is: { controlEnabled: true } } });
  }
  if (q.controlEnabled === false) {
    and.push({
      OR: [{ minPriceRule: null }, { minPriceRule: { controlEnabled: false } }],
    });
  }
  /** Ниже минимума / ошибки парсинга — объединяем в OR, если включено несколько флажков */
  const diagnosis: Prisma.WbProductWhereInput[] = [];
  if (q.belowMin) {
    diagnosis.push({ lastEvaluationStatus: "below_min" });
  }
  if (q.parseFailed) {
    diagnosis.push({ lastEvaluationStatus: "parse_failed" });
    diagnosis.push({ lastWalletParseStatus: "parse_failed" });
    diagnosis.push({ lastEvaluationStatus: "auth_problem" });
  }
  if (diagnosis.length === 1) {
    and.push(diagnosis[0]!);
  } else if (diagnosis.length > 1) {
    and.push({ OR: diagnosis });
  }
  if (q.buyerParseEnabled === true) {
    and.push({ buyerParseEnabled: true });
  }
  if (q.buyerParseEnabled === false) {
    and.push({ buyerParseEnabled: false });
  }
  return and.length ? { AND: and } : {};
}

export async function listProductsForCatalog(q: CatalogListQuery) {
  const where = buildWhere(q);
  const orderBy: Prisma.WbProductOrderByWithRelationInput = {
    [q.sortBy]: q.sortDir,
  };
  const [rows, total] = await Promise.all([
    prisma.wbProduct.findMany({
      where,
      take: q.limit,
      skip: q.offset,
      orderBy,
      include: { minPriceRule: true },
    }),
    prisma.wbProduct.count({ where }),
  ]);
  return { rows, total };
}

/** Уникальные бренды для фильтра в UI (не пустые) */
export async function listDistinctBrands(limit = 500): Promise<string[]> {
  const rows = await prisma.wbProduct.groupBy({
    by: ["brand"],
    where: { brand: { not: null } },
    orderBy: { brand: "asc" },
    take: limit,
  });
  return rows
    .map((r) => r.brand?.trim())
    .filter((b): b is string => Boolean(b));
}

export async function bulkSetControlEnabled(productIds: string[], controlEnabled: boolean) {
  await prisma.minPriceRule.updateMany({
    where: { productId: { in: productIds } },
    data: { controlEnabled },
  });
  return productIds.length;
}

export async function bulkUpdateMinPrice(
  updates: Array<{ productId: string; nmId: number; minAllowedFinalPrice: number }>,
  batchId: string | null,
) {
  let n = 0;
  for (const u of updates) {
    const prev = await prisma.minPriceRule.findUnique({ where: { productId: u.productId } });
    await prisma.minPriceRule.upsert({
      where: { productId: u.productId },
      create: {
        productId: u.productId,
        minAllowedFinalPrice: u.minAllowedFinalPrice,
        controlEnabled: true,
      },
      update: { minAllowedFinalPrice: u.minAllowedFinalPrice },
    });
    await prisma.minPriceTargetHistory.create({
      data: {
        productId: u.productId,
        nmId: u.nmId,
        previousMin: prev?.minAllowedFinalPrice ?? null,
        newMin: u.minAllowedFinalPrice,
        source: "bulk",
        batchId: batchId ?? undefined,
      },
    });
    n += 1;
  }
  return n;
}
