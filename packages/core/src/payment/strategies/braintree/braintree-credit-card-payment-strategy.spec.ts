import { createClient as createPaymentClient } from '@bigcommerce/bigpay-client';
import { createAction, createErrorAction, Action } from '@bigcommerce/data-store';
import { createRequestSender } from '@bigcommerce/request-sender';
import { createScriptLoader } from '@bigcommerce/script-loader';
import { merge, omit } from 'lodash';
import { from, of, Observable } from 'rxjs';

import { getBillingAddress } from '../../../billing/billing-addresses.mock';
import { createCheckoutStore, CheckoutRequestSender, CheckoutStore, CheckoutValidator } from '../../../checkout';
import { getCheckoutStoreState } from '../../../checkout/checkouts.mock';
import { MissingDataError, RequestError } from '../../../common/error/errors';
import { getResponse } from '../../../common/http-request/responses.mock';
import { getConfig } from '../../../config/configs.mock';
import { Order, OrderActionCreator, OrderActionType, OrderRequestBody, OrderRequestSender } from '../../../order';
import { OrderFinalizationNotRequiredError } from '../../../order/errors';
import { getOrderRequestBody } from '../../../order/internal-orders.mock';
import { getOrder } from '../../../order/orders.mock';
import { createSpamProtection, PaymentHumanVerificationHandler } from '../../../spam-protection';
import PaymentActionCreator from '../../payment-action-creator';
import { PaymentActionType } from '../../payment-actions';
import PaymentMethod from '../../payment-method';
import PaymentMethodActionCreator from '../../payment-method-action-creator';
import { PaymentMethodActionType } from '../../payment-method-actions';
import PaymentMethodRequestSender from '../../payment-method-request-sender';
import { getBraintree } from '../../payment-methods.mock';
import { PaymentInitializeOptions } from '../../payment-request-options';
import PaymentRequestSender from '../../payment-request-sender';
import PaymentRequestTransformer from '../../payment-request-transformer';

import BraintreeCreditCardPaymentStrategy from './braintree-credit-card-payment-strategy';
import { BraintreePaymentInitializeOptions } from './braintree-payment-options';
import BraintreePaymentProcessor from './braintree-payment-processor';

describe('BraintreeCreditCardPaymentStrategy', () => {
    let order: Order;
    let orderActionCreator: OrderActionCreator;
    let paymentMethodActionCreator: PaymentMethodActionCreator;
    let braintreePaymentProcessorMock: BraintreePaymentProcessor;
    let braintreeCreditCardPaymentStrategy: BraintreeCreditCardPaymentStrategy;
    let loadPaymentMethodAction: Observable<Action>;
    let paymentActionCreator: PaymentActionCreator;
    let paymentMethodMock: PaymentMethod;
    let store: CheckoutStore;
    let submitOrderAction: Observable<Action>;
    let submitPaymentAction: Observable<Action>;

    beforeEach(() => {
        braintreePaymentProcessorMock = {} as BraintreePaymentProcessor;
        braintreePaymentProcessorMock.initialize = jest.fn();
        braintreePaymentProcessorMock.deinitialize = jest.fn(() => Promise.resolve());
        braintreePaymentProcessorMock.initializeHostedForm = jest.fn();
        braintreePaymentProcessorMock.isInitializedHostedForm = jest.fn(() => Promise.resolve(true));
        braintreePaymentProcessorMock.deinitializeHostedForm = jest.fn(() => Promise.resolve());
        braintreePaymentProcessorMock.tokenizeCard = jest.fn(() => Promise.resolve({ nonce: 'my_tokenized_card' }));
        braintreePaymentProcessorMock.tokenizeHostedForm = jest.fn(() => Promise.resolve({ nonce: 'my_tokenized_card_with_hosted_form' }));
        braintreePaymentProcessorMock.tokenizeHostedFormForStoredCardVerification = jest.fn(() => Promise.resolve({ nonce: 'my_tokenized_card_verification_with_hosted_form' }));
        braintreePaymentProcessorMock.verifyCard = jest.fn(() => Promise.resolve({ nonce: 'my_verified_card' }));
        braintreePaymentProcessorMock.verifyCardWithHostedForm = jest.fn(() => Promise.resolve({ nonce: 'my_verified_card_with_hosted_form' }));
        braintreePaymentProcessorMock.verifyCardWithHostedFormAnd3DSCheck = jest.fn(() => Promise.resolve({ nonce: 'my_verified_card_with_hosted_form_after_3ds_check' }));
        braintreePaymentProcessorMock.challenge3DSVerification = jest.fn(() => Promise.resolve({ nonce: 'my_verified_stored_credit_card' }));
        braintreePaymentProcessorMock.getSessionId = jest.fn(() => Promise.resolve('my_session_id'));

        paymentMethodMock = {
            ...getBraintree(),
            clientToken: 'myToken',
            initializationData: {
                merchantAccountId: '100000',
            },
        };

        store = createCheckoutStore(getCheckoutStoreState());

        orderActionCreator = new OrderActionCreator(
            new OrderRequestSender(createRequestSender()),
            new CheckoutValidator(new CheckoutRequestSender(createRequestSender()))
        );
        paymentActionCreator = new PaymentActionCreator(
            new PaymentRequestSender(createPaymentClient()),
            orderActionCreator,
            new PaymentRequestTransformer(),
            new PaymentHumanVerificationHandler(createSpamProtection(createScriptLoader()))
        );
        paymentMethodActionCreator = new PaymentMethodActionCreator(new PaymentMethodRequestSender(createRequestSender()));

        order = getOrder();
        submitOrderAction = from([
            createAction(OrderActionType.SubmitOrderRequested),
            createAction(OrderActionType.LoadOrderSucceeded, order), // Currently we load the order after a successful submission
        ]);
        submitPaymentAction = of(createAction(PaymentActionType.SubmitPaymentRequested));
        loadPaymentMethodAction = of(createAction(PaymentMethodActionType.LoadPaymentMethodSucceeded, paymentMethodMock, { methodId: paymentMethodMock.id }));

        jest.spyOn(store, 'dispatch');

        jest.spyOn(orderActionCreator, 'submitOrder')
            .mockReturnValue(submitOrderAction);

        jest.spyOn(paymentActionCreator, 'submitPayment')
            .mockReturnValue(submitPaymentAction);

        jest.spyOn(paymentMethodActionCreator, 'loadPaymentMethod')
            .mockReturnValue(loadPaymentMethodAction);

        braintreeCreditCardPaymentStrategy = new BraintreeCreditCardPaymentStrategy(
            store,
            orderActionCreator,
            paymentActionCreator,
            paymentMethodActionCreator,
            braintreePaymentProcessorMock
        );
    });

    it('creates an instance of the braintree payment strategy', () => {
        expect(braintreeCreditCardPaymentStrategy).toBeInstanceOf(BraintreeCreditCardPaymentStrategy);
    });

    describe('#initialize()', () => {
        it('throws error if client token is missing', async () => {
            paymentMethodMock.clientToken = '';

            try {
                await braintreeCreditCardPaymentStrategy.initialize({ methodId: paymentMethodMock.id });
            } catch (error) {
                expect(error).toBeInstanceOf(MissingDataError);
            }
        });

        it('initializes the strategy', async () => {
            paymentMethodMock.config.isHostedFormEnabled = false;

            const options = { braintree: {}, methodId: paymentMethodMock.id };

            await braintreeCreditCardPaymentStrategy.initialize(options);

            expect(braintreePaymentProcessorMock.initialize).toHaveBeenCalledWith(paymentMethodMock.clientToken, options.braintree);
            expect(braintreePaymentProcessorMock.initializeHostedForm).not.toHaveBeenCalled();
            expect(braintreePaymentProcessorMock.isInitializedHostedForm).not.toHaveBeenCalled();
            expect(braintreePaymentProcessorMock.getSessionId).toHaveBeenCalled();
        });

        it('initializes the strategy as hosted form if feature is enabled and configuration is passed', async () => {
            paymentMethodMock.config.isHostedFormEnabled = true;

            const options = {
                methodId: paymentMethodMock.id,
                braintree: {
                    form: {
                        fields: {
                            cardName: { containerId: 'cardName' },
                            cardNumber: { containerId: 'cardNumber' },
                            cardExpiry: { containerId: 'cardExpiry' },
                        },
                    },
                },
            };

            await braintreeCreditCardPaymentStrategy.initialize(options);

            expect(braintreePaymentProcessorMock.initialize).toHaveBeenCalledWith(paymentMethodMock.clientToken, options.braintree);
            expect(braintreePaymentProcessorMock.initializeHostedForm).toHaveBeenCalledWith(options.braintree.form);
            expect(braintreePaymentProcessorMock.isInitializedHostedForm).toHaveBeenCalled();
            expect(braintreePaymentProcessorMock.getSessionId).toHaveBeenCalled();
        });

        // throws BraintreeError
        // throws another error
    });

    describe('#deinitialize()', () => {
        it('deinitializes strategy', async () => {
            await braintreeCreditCardPaymentStrategy.deinitialize();

            expect(braintreePaymentProcessorMock.deinitialize).toHaveBeenCalled();
            expect(braintreePaymentProcessorMock.deinitializeHostedForm).toHaveBeenCalled();
        });

        it('resets hosted form initialization state on strategy deinitialisation', async () => {
            braintreePaymentProcessorMock.deinitialize = jest.fn(() => Promise.resolve());
            paymentMethodMock.config.isHostedFormEnabled = true;

            await braintreeCreditCardPaymentStrategy.initialize({
                methodId: paymentMethodMock.id,
                braintree: {
                    form: {
                        fields: {
                            cardName: { containerId: 'cardName' },
                            cardNumber: { containerId: 'cardNumber' },
                            cardExpiry: { containerId: 'cardExpiry' },
                        },
                    },
                },
            });

            await braintreeCreditCardPaymentStrategy.deinitialize();
            await braintreeCreditCardPaymentStrategy.execute(getOrderRequestBody());

            expect(braintreePaymentProcessorMock.tokenizeHostedForm)
                .not.toHaveBeenCalled();
            expect(braintreePaymentProcessorMock.tokenizeCard)
                .toHaveBeenCalled();
        });
    });

    describe('#finalize()', () => {
        it('throws error to inform that order finalization is not required', async () => {
            try {
                await braintreeCreditCardPaymentStrategy.finalize();
            } catch (error) {
                expect(error).toBeInstanceOf(OrderFinalizationNotRequiredError);
            }
        });
    });

    describe('#execute()', () => {
        let orderRequestBody: OrderRequestBody;
        let options: PaymentInitializeOptions;

        beforeEach(() => {
            orderRequestBody = getOrderRequestBody();
            options = { methodId: paymentMethodMock.id };
        });

        describe('common execution behaviour', () => {
            it('calls submit order with the order request information', async () => {
                await braintreeCreditCardPaymentStrategy.execute(orderRequestBody, options);

                expect(orderActionCreator.submitOrder).toHaveBeenCalledWith(omit(orderRequestBody, 'payment'), expect.any(Object));
                expect(store.dispatch).toHaveBeenCalledWith(submitOrderAction);
            });

            it('pass the options to submitOrder', async () => {
                await braintreeCreditCardPaymentStrategy.execute(orderRequestBody, options);

                expect(orderActionCreator.submitOrder).toHaveBeenCalledWith(expect.any(Object), options);
            });

            it('throws error if unable to submit payment due to missing data', async () => {
                submitOrderAction = of(createAction(OrderActionType.SubmitOrderRequested));

                jest.spyOn(orderActionCreator, 'submitOrder')
                    .mockReturnValue(submitOrderAction);

                braintreeCreditCardPaymentStrategy = new BraintreeCreditCardPaymentStrategy(
                    store,
                    orderActionCreator,
                    paymentActionCreator,
                    paymentMethodActionCreator,
                    braintreePaymentProcessorMock
                );

                try {
                    await braintreeCreditCardPaymentStrategy.execute(orderRequestBody, options);
                } catch (error) {
                    expect(error).toBeInstanceOf(MissingDataError);
                }
            });
        });

        describe('non hosted form behaviour', () => {
            it('does not touch the card if it is going to be saved in the vault (shouldSaveInstrument: true)', async () => {
                const payload = merge({}, orderRequestBody, {
                    payment: { paymentData: { shouldSaveInstrument: true } },
                });

                await braintreeCreditCardPaymentStrategy.execute(payload, options);

                expect(paymentActionCreator.submitPayment).toHaveBeenCalledWith(payload.payment);
            });

            it('passes on optional flags to save and to make default', async () => {
                const payload = merge({}, orderRequestBody, {
                    payment: { paymentData: { shouldSaveInstrument: true, shouldSetAsDefaultInstrument: true } },
                });

                await braintreeCreditCardPaymentStrategy.execute(payload, options);

                expect(paymentActionCreator.submitPayment)
                    .toHaveBeenCalledWith(
                        expect.objectContaining({
                            paymentData: expect.objectContaining({
                                shouldSaveInstrument: true,
                                shouldSetAsDefaultInstrument: true,
                            }),
                        })
                    );
            });

            it('does nothing to VaultedInstruments', async () => {
                const payload = {
                    ...orderRequestBody,
                    payment: {
                        methodId: 'braintree',
                        paymentData: {
                            instrumentId: 'my_instrument_id',
                            iin: '123123',
                        },
                    },
                };

                await braintreeCreditCardPaymentStrategy.execute(payload, options);

                expect(paymentActionCreator.submitPayment).toHaveBeenCalledWith(payload.payment);
            });

            it('tokenizes the card', async () => {
                const expected = {
                    ...orderRequestBody.payment,
                    paymentData: {
                        deviceSessionId: 'my_session_id',
                        nonce: 'my_tokenized_card',
                        shouldSaveInstrument: false,
                        shouldSetAsDefaultInstrument: false,
                    },
                };

                await braintreeCreditCardPaymentStrategy.initialize({ methodId: paymentMethodMock.id });
                await braintreeCreditCardPaymentStrategy.execute(orderRequestBody, options);

                expect(braintreePaymentProcessorMock.tokenizeCard).toHaveBeenCalledWith(orderRequestBody.payment, getBillingAddress());
                expect(paymentActionCreator.submitPayment).toHaveBeenCalledWith(expected);
                expect(store.dispatch).toHaveBeenCalledWith(submitPaymentAction);
            });

            it('verifies the card if 3ds is enabled', async () => {
                const options3ds = { methodId: paymentMethodMock.id };

                paymentMethodMock.config.is3dsEnabled = true;

                await braintreeCreditCardPaymentStrategy.initialize(options3ds);

                const expected = {
                    ...orderRequestBody.payment,
                    paymentData: {
                        deviceSessionId: 'my_session_id',
                        nonce: 'my_verified_card',
                        shouldSaveInstrument: false,
                        shouldSetAsDefaultInstrument: false,
                    },
                };

                await braintreeCreditCardPaymentStrategy.execute(orderRequestBody, options);

                expect(braintreePaymentProcessorMock.verifyCard).toHaveBeenCalledWith(orderRequestBody.payment, getBillingAddress(), 190);
                expect(paymentActionCreator.submitPayment).toHaveBeenCalledWith(expected);
                expect(store.dispatch).toHaveBeenCalledWith(submitPaymentAction);
            });
        });

        describe('hosted form behaviour', () => {
            let initializeOptions: BraintreePaymentInitializeOptions;

            beforeEach(() => {
                initializeOptions = {
                    form: {
                        fields: {
                            cardName: { containerId: 'cardName' },
                            cardNumber: { containerId: 'cardNumber' },
                            cardExpiry: { containerId: 'cardExpiry' },
                        },
                    },
                };

                paymentMethodMock.config.isHostedFormEnabled = true;
            });

            it('tokenizes payment data through hosted form and submits it', async () => {
                await braintreeCreditCardPaymentStrategy.initialize({
                    methodId: paymentMethodMock.id,
                    braintree: initializeOptions,
                });

                await braintreeCreditCardPaymentStrategy.execute(orderRequestBody);

                expect(braintreePaymentProcessorMock.tokenizeHostedForm)
                    .toHaveBeenCalledWith(getBillingAddress());

                expect(paymentActionCreator.submitPayment)
                    .toHaveBeenCalledWith({
                        ...orderRequestBody.payment,
                        paymentData: {
                            deviceSessionId: 'my_session_id',
                            nonce: 'my_tokenized_card_with_hosted_form',
                            shouldSaveInstrument: false,
                            shouldSetAsDefaultInstrument: false,
                        },
                    });
            });

            it('passes on optional flags to save and to make default', async () => {
                await braintreeCreditCardPaymentStrategy.initialize({
                    methodId: paymentMethodMock.id,
                    braintree: initializeOptions,
                });

                const payload = merge({}, orderRequestBody, {
                    payment: { paymentData: { shouldSaveInstrument: true, shouldSetAsDefaultInstrument: true } },
                });

                await braintreeCreditCardPaymentStrategy.execute(payload, options);

                expect(paymentActionCreator.submitPayment)
                    .toHaveBeenCalledWith(
                        expect.objectContaining({
                            paymentData: expect.objectContaining({
                                shouldSaveInstrument: true,
                                shouldSetAsDefaultInstrument: true,
                            }),
                        })
                    );
            });

            it('verifies payment data with 3DS through hosted form and submits it if 3DS is enabled', async () => {
                paymentMethodMock.config.is3dsEnabled = true;

                await braintreeCreditCardPaymentStrategy.initialize({
                    methodId: paymentMethodMock.id,
                    braintree: initializeOptions,
                });

                await braintreeCreditCardPaymentStrategy.execute(orderRequestBody);

                expect(braintreePaymentProcessorMock.verifyCardWithHostedForm)
                    .toHaveBeenCalledWith(getBillingAddress(), 190);
                expect(braintreePaymentProcessorMock.verifyCardWithHostedFormAnd3DSCheck)
                    .not.toHaveBeenCalled();

                expect(paymentActionCreator.submitPayment)
                    .toHaveBeenCalledWith({
                        ...orderRequestBody.payment,
                        paymentData: {
                            deviceSessionId: 'my_session_id',
                            nonce: 'my_verified_card_with_hosted_form',
                            shouldSaveInstrument: false,
                            shouldSetAsDefaultInstrument: false,
                        },
                    });
            });

            it('verifies payment data through hosted form with 3DS regulation check if 3DS and an experiment are enabled', async () => {
                const config = getConfig();
                jest.spyOn(store.getState().config, 'getStoreConfigOrThrow')
                    .mockReturnValue({
                        ...config.storeConfig,
                        checkoutSettings: {
                            ...config.storeConfig.checkoutSettings,
                            features: {
                                'PAYPAL-1177.braintree-3ds-issue': true,
                            },
                        },
                    });

                paymentMethodMock.config.is3dsEnabled = true;
                paymentMethodMock.initializationData.merchantAccountId = '100000';

                await braintreeCreditCardPaymentStrategy.initialize({
                    methodId: paymentMethodMock.id,
                    braintree: initializeOptions,
                });

                await braintreeCreditCardPaymentStrategy.execute(orderRequestBody);

                expect(braintreePaymentProcessorMock.verifyCardWithHostedForm).not.toHaveBeenCalled();
                expect(braintreePaymentProcessorMock.verifyCardWithHostedFormAnd3DSCheck)
                    .toHaveBeenCalledWith(getBillingAddress(), 190, '100000');

                expect(paymentActionCreator.submitPayment)
                    .toHaveBeenCalledWith({
                        ...orderRequestBody.payment,
                        paymentData: {
                            deviceSessionId: 'my_session_id',
                            nonce: 'my_verified_card_with_hosted_form_after_3ds_check',
                            shouldSaveInstrument: false,
                            shouldSetAsDefaultInstrument: false,
                        },
                    });
            });

            it('throws an error if merchant account id is not provided when verifies payment data through hosted form with 3DS regulation check if 3DS and an experiment are enabled', async () => {
                const config = getConfig();
                jest.spyOn(store.getState().config, 'getStoreConfigOrThrow')
                    .mockReturnValue({
                        ...config.storeConfig,
                        checkoutSettings: {
                            ...config.storeConfig.checkoutSettings,
                            features: {
                                'PAYPAL-1177.braintree-3ds-issue': true,
                            },
                        },
                    });

                paymentMethodMock.config.is3dsEnabled = true;
                paymentMethodMock.initializationData.merchantAccountId = undefined;

                await braintreeCreditCardPaymentStrategy.initialize({
                    methodId: paymentMethodMock.id,
                    braintree: initializeOptions,
                });

                try {
                    await braintreeCreditCardPaymentStrategy.execute(orderRequestBody);
                } catch (error) {
                    expect(error).toBeInstanceOf(MissingDataError);
                }

                expect(braintreePaymentProcessorMock.verifyCardWithHostedForm).not.toHaveBeenCalled();
                expect(braintreePaymentProcessorMock.verifyCardWithHostedFormAnd3DSCheck).not.toHaveBeenCalled();
                expect(paymentActionCreator.submitPayment).not.toHaveBeenCalled();
            });

            it('tokenizes stored card verification data through hosted form and submits it if paying with stored card', async () => {
                await braintreeCreditCardPaymentStrategy.initialize({
                    methodId: paymentMethodMock.id,
                    braintree: initializeOptions,
                });

                await braintreeCreditCardPaymentStrategy.execute({
                    ...orderRequestBody,
                    payment: {
                        methodId: paymentMethodMock.id,
                        paymentData: {
                            instrumentId: 'foobar_instrument',
                        },
                    },
                });

                expect(braintreePaymentProcessorMock.tokenizeHostedFormForStoredCardVerification)
                    .toHaveBeenCalledWith();

                expect(paymentActionCreator.submitPayment)
                    .toHaveBeenCalledWith({
                        methodId: paymentMethodMock.id,
                        paymentData: {
                            deviceSessionId: 'my_session_id',
                            instrumentId: 'foobar_instrument',
                            nonce: 'my_tokenized_card_verification_with_hosted_form',
                        },
                    });
            });

            it('does not verify payment data with 3DS through hosted form and if paying with stored card', async () => {
                paymentMethodMock.config.is3dsEnabled = true;

                await braintreeCreditCardPaymentStrategy.initialize({
                    methodId: paymentMethodMock.id,
                    braintree: initializeOptions,
                });

                await braintreeCreditCardPaymentStrategy.execute({
                    ...orderRequestBody,
                    payment: {
                        methodId: paymentMethodMock.id,
                        paymentData: {
                            instrumentId: 'foobar_instrument',
                        },
                    },
                });

                expect(braintreePaymentProcessorMock.tokenizeHostedFormForStoredCardVerification)
                    .toHaveBeenCalledWith();

                expect(paymentActionCreator.submitPayment)
                    .toHaveBeenCalledWith({
                        methodId: paymentMethodMock.id,
                        paymentData: {
                            deviceSessionId: 'my_session_id',
                            instrumentId: 'foobar_instrument',
                            nonce: 'my_tokenized_card_verification_with_hosted_form',
                        },
                    });
            });

            it('challenges 3ds verification for stored credit card if gets 3ds required error on submit payment', async () => {
                const config = getConfig();
                jest.spyOn(store.getState().config, 'getStoreConfigOrThrow')
                    .mockReturnValue({
                        ...config.storeConfig,
                        checkoutSettings: {
                            ...config.storeConfig.checkoutSettings,
                            features: {
                                'PAYPAL-1177.braintree-3ds-issue': true,
                            },
                        },
                    });

                const threeDSecureNonce = 'tds_nonce_for_stored_credit_card';
                const threeDSecureRequired = new RequestError({
                    ...getResponse({
                        errors: [{ code: 'three_d_secure_required' }],
                        three_ds_result: {
                            payer_auth_request: threeDSecureNonce,
                        },
                    }),
                });

                jest.spyOn(paymentActionCreator, 'submitPayment')
                    .mockReturnValueOnce(of(createErrorAction(PaymentActionType.SubmitPaymentFailed, threeDSecureRequired)))
                    .mockReturnValueOnce(submitPaymentAction);

                const payload = {
                    payment: {
                        methodId: 'braintree',
                        paymentData: {
                            instrumentId: 'my_instrument_id',
                        },
                    },
                };

                await braintreeCreditCardPaymentStrategy.initialize({ methodId: paymentMethodMock.id });
                await braintreeCreditCardPaymentStrategy.execute(payload, options);

                expect(paymentActionCreator.submitPayment).toHaveBeenCalledTimes(2);
                expect(braintreePaymentProcessorMock.challenge3DSVerification).toHaveBeenCalledWith(threeDSecureNonce, getOrder().orderAmount);
            });
        });
    });
});