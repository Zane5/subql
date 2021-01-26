// Copyright 2020-2021 OnFinality Limited authors & contributors
// SPDX-License-Identifier: Apache-2.0

import assert from 'assert';
import { Injectable } from '@nestjs/common';
import { getAllEntities } from '@subql/common';
import { Entity, Store } from '@subql/types';
import { getDirectiveValues, GraphQLSchema, isNonNullType } from 'graphql';
import { Sequelize, Transaction } from 'sequelize';
import { isBasicType, objectTypeToModelAttributes } from '../utils/graphql';
import {
  commentConstraintQuery,
  getFkConstraint,
  smartTags,
} from '../utils/sync-helper';

@Injectable()
export class StoreService {
  private tx?: Transaction;

  constructor(private sequelize: Sequelize) {}

  async syncSchema(
    graphqlSchema: GraphQLSchema,
    schema: string,
  ): Promise<void> {
    const entities = getAllEntities(graphqlSchema);

    for (const entity of entities) {
      const modelAttributes = objectTypeToModelAttributes(entity);
      this.sequelize.define(entity.name, modelAttributes, {
        // timestamps: false,
        underscored: true,
        freezeTableName: false,
        schema,
      });
    }

    const derivedFrom = graphqlSchema.getDirective('derivedFrom');
    const extraQueries = [];
    for (const entity of entities) {
      const model = this.sequelize.model(entity.name);
      for (const [k, field] of Object.entries(entity.getFields())) {
        const values = getDirectiveValues(derivedFrom, field.astNode);
        let t = field.type;
        if (isNonNullType(t)) {
          t = t.ofType;
        }
        // eslint-disable-next-line @typescript-eslint/prefer-regexp-exec
        const matcher = t.toString().match(/^\[(.+)!?\]$/);
        if (!matcher) {
          // single item
          const type = t.toString();
          if (isBasicType(type)) {
            continue;
          }
          const relatedModel = this.sequelize.model(t.toString());
          if (values) {
            // todo: 1to1 relation
            // model.hasOne(relatedModel, {foreignKey: `${values.field}Id`});
          } else {
            model.belongsTo(relatedModel, { foreignKey: `${k}Id` });
          }
        } else {
          // list item
          if (!values) {
            continue;
          }
          const relatedModel = this.sequelize.model(matcher[1]);
          const rel = model.hasMany(relatedModel, {
            foreignKey: `${values.field}Id`,
          });
          const fkConstraint = getFkConstraint(
            rel.target.tableName,
            rel.foreignKey,
          );
          const tags = smartTags({
            fieldName: values.field,
            foreignFieldName: k,
          });
          extraQueries.push(
            commentConstraintQuery(
              `${schema}.${rel.target.tableName}`,
              fkConstraint,
              tags,
            ),
          );
        }
      }
    }
    await this.sequelize.sync();
    await this.sequelize.query(extraQueries.join('\n'));
  }

  setTransaction(tx: Transaction) {
    if (this.tx) {
      throw new Error('more than one tx created');
    }
    this.tx = tx;
    tx.afterCommit(() => (this.tx = undefined));
  }

  getStore(): Store {
    return {
      get: async (entity: string, id: string): Promise<Entity | null> => {
        const model = this.sequelize.model(entity);
        assert(model, `model ${entity} not exists`);
        const record = await model.findOne({
          where: { id },
          transaction: this.tx,
        });
        return record?.toJSON() as Entity;
      },
      set: async (entity: string, id: string, data: Entity): Promise<void> => {
        const model = this.sequelize.model(entity);
        assert(model, `model ${entity} not exists`);
        await model.upsert(data, { transaction: this.tx });
      },
      remove: async (entity: string, id: string): Promise<void> => {
        const model = this.sequelize.model(entity);
        assert(model, `model ${entity} not exists`);
        await model.destroy({ where: { id }, transaction: this.tx });
      },
    };
  }
}
