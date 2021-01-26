// Copyright 2020-2021 OnFinality Limited authors & contributors
// SPDX-License-Identifier: Apache-2.0

import {
  GraphQLObjectType,
  GraphQLOutputType,
  isNonNullType,
  GraphQLDirective,
  getDirectiveValues,
} from 'graphql';
import { ModelAttributes } from 'sequelize';
import { ModelAttributeColumnOptions } from 'sequelize/types/lib/model';

const SEQUELIZE_TYPE_MAPPING = {
  ID: 'text',
  Int: 'integer',
  BigInt: 'numeric',
  String: 'text',
  Date: 'timestamp',
  BigDecimal: 'numeric',
  Boolean: 'boolean',
  Bytes: 'bytea',
};

/* eslint-disable @typescript-eslint/no-explicit-any */
export function objectTypeToModelAttributes(
  objectType: GraphQLObjectType,
): ModelAttributes<any> {
  const fields = objectType.getFields();
  return Object.entries(fields).reduce((acc, [k, v]) => {
    let type: GraphQLOutputType = v.type;
    let allowNull = true;
    const name = k;

    if (isNonNullType(type)) {
      type = type.ofType;
      allowNull = false;
    }

    if (/^\[(.+)\]$/.test(type.toString())) {
      // skip list type for relation definition
      return acc;
    }

    const dbType = SEQUELIZE_TYPE_MAPPING[type.toString()];
    if (!dbType) {
      return acc;
    }

    const columnOption: ModelAttributeColumnOptions<any> = {
      type: dbType,
      allowNull,
      primaryKey: type.toString() === 'ID',
    };
    if (type.toString() === 'BigInt') {
      columnOption.get = function () {
        const dataValue = this.getDataValue(k);
        return dataValue ? BigInt(dataValue) : null;
      };
      columnOption.set = function (val: unknown) {
        this.setDataValue(name, val?.toString());
      };
    }
    acc[name] = columnOption;
    return acc;
  }, {} as ModelAttributes<any>);
}

export function isBasicType(t: string): boolean {
  return Object.keys(SEQUELIZE_TYPE_MAPPING).findIndex((k) => k === t) >= 0;
}
