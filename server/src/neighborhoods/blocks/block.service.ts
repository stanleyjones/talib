import { Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Pagination } from "nestjs-typeorm-paginate";
import { DataSource, Repository } from "typeorm";
import { Block } from "../../database/entities/block.entity";
import { Neighborhood } from "../../database/entities/neighborhood.entity";
import { TransactionDetails } from "../../database/entities/transaction-details.entity";
import { Transaction } from "../../database/entities/transaction.entity";
import { BlockDto } from "../../dto/block.dto";
import { NetworkService } from "../../services/network.service";
import { TxAnalyzerService } from "../../services/scheduler/tx-analyzer.service";
import {
  Block as ManyBlock,
  Transaction as ManyTransaction,
} from "../../utils/blockchain";
import { bufferToHex } from "../../utils/convert";

@Injectable()
export class BlockService {
  private readonly logger = new Logger(BlockService.name);

  constructor(
    @InjectRepository(Block)
    private blockRepository: Repository<Block>,
    @InjectRepository(Transaction)
    private transactionRepository: Repository<Transaction>,
    private network: NetworkService,
    private dataSource: DataSource,
    private analyzer: TxAnalyzerService,
  ) {}

  findOneByHeight(
    neighborhoodId: number,
    height: number,
  ): Promise<Block | null> {
    return this.blockRepository.findOneBy({
      neighborhood: { id: neighborhoodId },
      height: height,
    });
  }

  async findOneByHash(nid: number, hash: ArrayBuffer): Promise<Block> {
    const q = this.blockRepository
      .createQueryBuilder("b")
      .where("b.neighborhoodId = :nid", { nid })
      .andWhere("b.hash = :hash", { hash })
      .leftJoinAndMapMany(
        "b.transactions",
        "transaction",
        "t",
        `"t"."blockId" = "b"."id"`,
      )
      .leftJoinAndMapOne(
        "t.details",
        TransactionDetails,
        "details",
        `"details"."transactionId" = "t"."id"`,
      );

    this.logger.debug(`findOneByHash(${nid}, ${bufferToHex(hash)}): `);
    return q.getOne();
  }

  public async findManyDto(
    neighborhoodId: number,
    options: { limit: number; page?: number },
  ): Promise<Pagination<BlockDto>> {
    const clamp = (n, min, max) => Math.min(Math.max(n, min), max);
    const limit = clamp(options.limit, 1, 1000);
    const page = clamp(options.page || 1, 1, Infinity);
    const offset = (page - 1) * limit;

    const driver = this.blockRepository.manager.connection.driver;
    const metadata = this.blockRepository.metadata;
    const timeColumnMetadata = metadata.ownColumns.find(
      (x) => x.propertyName == "time",
    );
    const isPostgres = driver.options.type == "postgres";

    const query = this.dataSource
      .createQueryBuilder()
      .select("b.height", "height")
      // In PostGres if we don't ask for the specific type we get an incorrect
      // string and won't format the field properly on the output.
      .addSelect(`b.time${isPostgres ? "::timestamptz" : ""}`, "time")
      .addSelect("b.hash", "hash")
      .addSelect("b.appHash", "appHash")
      .addSelect("COUNT(transactions.id)", "txCount")
      .from("block", "b")
      .leftJoin("b.transactions", "transactions")
      .where(`b."neighborhoodId" = :nid`, { nid: neighborhoodId })
      .groupBy(`height, time, b.hash, b."appHash"`)
      .orderBy("height", "DESC")
      .limit(limit)
      .offset(offset);
    const countQuery = this.blockRepository
      .createQueryBuilder("b")
      .select("MAX(height) as height")
      .where({ neighborhood: { id: neighborhoodId } });

    this.logger.debug(`findMany(${neighborhoodId}): ${query.getQuery()}`);

    const totalItems = (await countQuery.getRawOne<{ height: number }>())
      .height;
    const items = await query.getRawMany();

    return {
      items: items.map((x) => ({
        height: x.height,
        dateTime: driver
          .prepareHydratedValue(x.time, timeColumnMetadata)
          .toISOString(),
        appHash: bufferToHex(x.appHash),
        blockHash: bufferToHex(x.hash),
        txCount: Number(x.txCount) || 0,
      })),
      meta: {
        totalItems,
        itemCount: items.length,
        itemsPerPage: limit,
        totalPages: Math.ceil(totalItems / limit),
        currentPage: page,
      },
    };
  }

  async getLatestHeightFetched(
    neighborhood: Neighborhood,
  ): Promise<number | null> {
    const blocks = await this.findManyDto(neighborhood.id, { limit: 1 });
    const last = blocks[0]; // Ordered by height descending.
    return last?.height;
  }

  async getLatestHeightOf(neighborhood: Neighborhood): Promise<number> {
    const n = await this.network.forUrl(neighborhood.url);
    const info = await n.blockchain.info();
    return info.latestBlock.height;
  }

  async getGenesisBlockHash(
    neighborhood: Neighborhood,
  ): Promise<ArrayBuffer | null> {
    const n = await this.network.forUrl(neighborhood.url);
    const blockInfo = await n.blockchain.blockByHeight(1);
    return blockInfo?.identifier.hash;
  }

  private missingBlockHeightsQueryForPostgres(
    neighborhood: Neighborhood,
    latestHeight: number,
    max?: number,
  ) {
    return `
        SELECT all_ids AS missnum
        FROM generate_series(1, ${latestHeight}) all_ids
        EXCEPT
        SELECT height FROM block WHERE "neighborhoodId" = ${neighborhood.id}
        ORDER BY missnum
        ${max !== undefined ? "LIMIT " + max : ""}
    `;
  }

  private missingBlockHeightsQueryForSqlite(
    neighborhood: Neighborhood,
    latestHeight: number,

    max?: number,
  ) {
    return `
      WITH Missing (missnum, maxid) AS (
        SELECT 1 AS missnum, ${latestHeight}
        UNION ALL
        SELECT missnum + 1, maxid FROM Missing
        WHERE missnum < maxid
      )
      SELECT missnum
      FROM Missing
      LEFT OUTER JOIN block tt on tt.height = Missing.missnum
      WHERE tt.height is NULL
      ${max !== undefined ? "LIMIT " + max : ""}
    ;`;
  }

  async missingBlockHeightsForNeighborhood(
    neighborhood: Neighborhood,
    maxHeight: number,
    count = 500,
  ): Promise<number[]> {
    const queryFns = {
      postgres: (n, h, c) => this.missingBlockHeightsQueryForPostgres(n, h, c),
      sqlite: (n, h, c) => this.missingBlockHeightsQueryForSqlite(n, h, c),
    };
    const driver = this.blockRepository.manager.connection.options.type;
    if (queryFns[driver] === undefined) {
      throw new Error(
        `We do not support ${driver} for fetching missing heights. File a bug on Talib's repo.`,
      );
    }
    const query = queryFns[driver](neighborhood, maxHeight, count);

    const result = await this.dataSource.query(query);
    return result.map((r) => Number(r.missnum)) as number[];
  }

  async createFromManyBlock(neighborhood: Neighborhood, block: ManyBlock) {
    const entity = new Block();
    entity.appHash = block.appHash;
    entity.height = block.identifier.height;
    entity.hash = block.identifier.hash;
    entity.time = block.time;
    entity.neighborhood = neighborhood;

    const transactions = await Promise.all(
      block.transactions.map(async (tx, i) => {
        const transaction = new Transaction();
        await this.populateTransaction(neighborhood, entity, tx);
        transaction.block = entity;
        transaction.hash = tx.hash;
        transaction.request = tx.request;
        transaction.response = tx.response;
        transaction.block_index = i;

        return transaction;
      }),
    );
    entity.transactions = transactions;

    const result = await this.blockRepository.save(entity);
    await this.transactionRepository.save(transactions);
    return result;
  }

  async populateTransaction(
    neighborhood: Neighborhood,
    block: Block,
    tx: ManyTransaction,
  ): Promise<ManyTransaction> {
    const n = await this.network.forUrl(neighborhood.url);
    const [request, response] = await Promise.all([
      tx.request ?? n.blockchain.request(tx.hash),
      tx.response ?? n.blockchain.response(tx.hash),
    ]);

    tx.request = request;
    tx.response = response;
    return tx;
  }
}
