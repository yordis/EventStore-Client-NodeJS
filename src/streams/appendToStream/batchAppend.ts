import { v4 as uuid } from "uuid";

import { StreamsClient } from "../../../generated/streams_grpc_pb";
import { BatchAppendReq, BatchAppendResp } from "../../../generated/streams_pb";
import { Empty, StreamIdentifier, UUID } from "../../../generated/shared_pb";

import { Client } from "../../Client";
import { AppendResult, EventData } from "../../types";
import {
  debug,
  createUUID,
  parseUUID,
  convertToCommandError,
} from "../../utils";

import {
  unpackToCommandError,
  unpackWrongExpectedVersion,
} from "./unpackError";
import { InternalAppendToStreamOptions } from ".";

const streamCache = new WeakMap<
  StreamsClient,
  ReturnType<StreamsClient["batchAppend"]>
>();

export const batchAppend = async function (
  this: Client,
  streamName: string,
  events: EventData[],
  {
    expectedRevision,
    batchAppendSize,
    ...baseOptions
  }: InternalAppendToStreamOptions
): Promise<AppendResult> {
  const correlationId = uuid();

  const stream = await this.GRPCStreamCreator(
    StreamsClient,
    "appendToStream",
    (client) =>
      client.batchAppend(
        ...this.callArguments(baseOptions, {
          deadline: Infinity,
        })
      ),
    streamCache
  )();

  return new Promise((resolve, reject) => {
    const detach = () => {
      stream.off("data", handleData).off("error", handleError);
    };

    const handleData = (resp: BatchAppendResp) => {
      const resultingId = parseUUID(resp.getCorrelationId());
      if (correlationId !== resultingId) return;

      detach();

      if (resp.hasError()) {
        const grpcError = resp.getError()!;

        if (!this.throwOnAppendFailure) {
          const wrongExpectedVersion = unpackWrongExpectedVersion(grpcError);

          if (wrongExpectedVersion) {
            const nextExpectedRevision =
              wrongExpectedVersion.hasCurrentStreamRevision()
                ? BigInt(wrongExpectedVersion.hasCurrentStreamRevision())
                : BigInt(-1);

            return resolve({
              success: false,
              nextExpectedRevision,
              position: undefined,
            });
          }
        }

        return reject(unpackToCommandError(grpcError, streamName));
      }

      const success = resp.getSuccess()!;
      const nextExpectedRevision = BigInt(success.getCurrentRevision());
      const grpcPosition = success.getPosition();

      const position = grpcPosition
        ? {
            commit: BigInt(grpcPosition.getCommitPosition()),
            prepare: BigInt(grpcPosition.getPreparePosition()),
          }
        : undefined;

      return resolve({
        success: true,
        nextExpectedRevision,
        position,
      });
    };

    const handleError = (error: Error) => {
      detach();
      return reject(convertToCommandError(error));
    };

    stream.on("data", handleData).on("error", handleError);

    const correlationUUID = createUUID(correlationId);
    const options = new BatchAppendReq.Options();
    const identifier = new StreamIdentifier();
    identifier.setStreamName(Uint8Array.from(Buffer.from(streamName, "utf8")));
    options.setStreamIdentifier(identifier);
    switch (expectedRevision) {
      case "any": {
        options.setAny(new Empty());
        break;
      }
      case "no_stream": {
        options.setNoStream(new Empty());
        break;
      }
      case "stream_exists": {
        options.setStreamExists(new Empty());
        break;
      }
      default: {
        options.setStreamPosition(expectedRevision.toString(10));
        break;
      }
    }

    for (const batch of eventBatcher(
      events,
      correlationUUID,
      options,
      batchAppendSize
    )) {
      debug.command_grpc("batchAppend: %g", batch);
      stream.write(batch);
    }
  });
};

function* eventBatcher(
  events: EventData[],
  correlationId: UUID,
  options: BatchAppendReq.Options,
  maxBatchSize: number
) {
  const createAppendRequest = (addOptions = false) => {
    const appendRequest = new BatchAppendReq();
    if (addOptions) {
      appendRequest.setOptions(options);
    }
    appendRequest.setCorrelationId(correlationId);
    appendRequest.setIsFinal(false);
    return appendRequest;
  };

  let appendRequest = createAppendRequest(true);
  let batchSize = 0;

  for (const event of events) {
    const message = new BatchAppendReq.ProposedMessage();

    const id = new UUID();
    id.setString(event.id);
    message.setId(id);
    message.getMetadataMap().set("type", event.type);
    message.getMetadataMap().set("content-type", event.contentType);

    switch (event.contentType) {
      case "application/json": {
        const data = JSON.stringify(event.data);
        message.setData(Buffer.from(data, "utf8").toString("base64"));
        break;
      }
      case "application/octet-stream": {
        message.setData(event.data);
        break;
      }
    }

    if (event.metadata) {
      if (event.metadata.constructor === Uint8Array) {
        message.setCustomMetadata(event.metadata);
      } else {
        const metadata = JSON.stringify(event.metadata);
        message.setCustomMetadata(
          Buffer.from(metadata, "utf8").toString("base64")
        );
      }
    }

    const messageSize = message.serializeBinary().length;

    if (batchSize + messageSize >= maxBatchSize) {
      yield appendRequest;
      appendRequest = createAppendRequest(false);
      batchSize = 0;
    }

    batchSize += messageSize;
    appendRequest.addProposedMessages(message);
  }

  appendRequest.setIsFinal(true);

  yield appendRequest;
}
