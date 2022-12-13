import { omit } from 'lodash';

import {
    OrderFinalizationNotRequiredError,
    OrderRequestBody,
    PaymentIntegrationService,
    PaymentRequestOptions,
    PaymentStrategy,
} from '@bigcommerce/checkout-sdk/payment-integration-api';

export default class OfflinePaymentStrategy implements PaymentStrategy {
    constructor(private _paymentIntegrationService: PaymentIntegrationService) {}

    async execute(payload: OrderRequestBody, options?: PaymentRequestOptions): Promise<void> {
        await this._paymentIntegrationService.submitOrder(omit(payload, 'payment'), options);

        return Promise.resolve();
    }

    finalize(): Promise<void> {
        return Promise.reject(new OrderFinalizationNotRequiredError());
    }

    initialize(): Promise<void> {
        return Promise.resolve();
    }

    deinitialize(): Promise<void> {
        return Promise.resolve();
    }
}
