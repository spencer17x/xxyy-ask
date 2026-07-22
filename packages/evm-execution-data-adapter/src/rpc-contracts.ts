import { z } from 'zod';

import { rpcHexQuantitySchema } from '@xxyy/evm-data-adapter';
import { evmAddressSchema, evmHashSchema } from '@xxyy/transaction-analysis-core';

import {
  POOL_FACTORY_SELECTOR,
  POOL_TOKEN0_SELECTOR,
  POOL_TOKEN1_SELECTOR,
  UNISWAP_V2_GET_PAIR_SELECTOR,
  UNISWAP_V3_FEE_SELECTOR,
  UNISWAP_V3_GET_POOL_SELECTOR,
} from './contracts.js';

export const CALL_TRACER_SERVER_TIMEOUT = '10s' as const;

const poolContextShape = {
  poolAddress: evmAddressSchema,
} as const;

const exactCallParams = (selector: string) =>
  z.tuple([
    z
      .object({
        data: z.literal(selector),
        to: evmAddressSchema,
      })
      .strict(),
    rpcHexQuantitySchema,
  ]);

const factoryLookupDataSchema = z
  .string()
  .regex(
    /^(?:0xe6a43905[0-9a-fA-F]{128}|0x1698ee82[0-9a-fA-F]{192})$/u,
    'Expected an allowlisted factory lookup call.',
  )
  .transform((value) => value.toLowerCase())
  .superRefine((value, context) => {
    if (
      !value.startsWith(UNISWAP_V2_GET_PAIR_SELECTOR) &&
      !value.startsWith(UNISWAP_V3_GET_POOL_SELECTOR)
    ) {
      context.addIssue({ code: 'custom', message: 'Unsupported factory lookup selector.' });
    }
  });

const poolCallSchemas = [
  ['pool_factory', POOL_FACTORY_SELECTOR],
  ['pool_token0', POOL_TOKEN0_SELECTOR],
  ['pool_token1', POOL_TOKEN1_SELECTOR],
  ['pool_fee', UNISWAP_V3_FEE_SELECTOR],
] as const;

export const executionRpcCallSchema = z.discriminatedUnion('operation', [
  z
    .object({
      method: z.literal('eth_chainId'),
      operation: z.literal('chain_id'),
      params: z.tuple([]),
    })
    .strict(),
  z
    .object({
      method: z.literal('debug_traceTransaction'),
      operation: z.literal('trace'),
      params: z.tuple([
        evmHashSchema,
        z
          .object({
            timeout: z.literal(CALL_TRACER_SERVER_TIMEOUT),
            tracer: z.literal('callTracer'),
            tracerConfig: z
              .object({ onlyTopCall: z.literal(false), withLog: z.literal(false) })
              .strict(),
          })
          .strict(),
      ]),
    })
    .strict(),
  z
    .object({
      ...poolContextShape,
      method: z.literal('eth_getCode'),
      operation: z.literal('pool_code'),
      params: z.tuple([evmAddressSchema, rpcHexQuantitySchema]),
    })
    .strict()
    .refine((call) => call.params[0] === call.poolAddress, {
      message: 'Pool code target must match poolAddress.',
      path: ['params', 0],
    }),
  ...poolCallSchemas.map(([operation, selector]) =>
    z
      .object({
        ...poolContextShape,
        method: z.literal('eth_call'),
        operation: z.literal(operation),
        params: exactCallParams(selector),
      })
      .strict()
      .refine((call) => call.params[0].to === call.poolAddress, {
        message: 'Pool call target must match poolAddress.',
        path: ['params', 0, 'to'],
      }),
  ),
  z
    .object({
      factoryAddress: evmAddressSchema,
      ...poolContextShape,
      method: z.literal('eth_getCode'),
      operation: z.literal('factory_code'),
      params: z.tuple([evmAddressSchema, rpcHexQuantitySchema]),
    })
    .strict()
    .refine((call) => call.params[0] === call.factoryAddress, {
      message: 'Factory code target must match factoryAddress.',
      path: ['params', 0],
    }),
  z
    .object({
      factoryAddress: evmAddressSchema,
      ...poolContextShape,
      method: z.literal('eth_call'),
      operation: z.literal('factory_lookup'),
      params: z.tuple([
        z
          .object({
            data: factoryLookupDataSchema,
            to: evmAddressSchema,
          })
          .strict(),
        rpcHexQuantitySchema,
      ]),
    })
    .strict()
    .superRefine((call, context) => {
      if (call.params[0].to !== call.factoryAddress) {
        context.addIssue({
          code: 'custom',
          message: 'Factory lookup target must match factoryAddress.',
          path: ['params', 0, 'to'],
        });
      }
    }),
]);

export type ExecutionRpcCall = z.output<typeof executionRpcCallSchema>;
