import GooglePayWorldpayInitializer from './googlepay-worldpay-initializer';
import {
    getCheckoutMock,
    getWorldpayPaymentDataMock,
    getWorldpayPaymentDataRequest,
    getWorldpayPaymentMethodMock,
    getWorldpayTokenizedPayload,
} from './googlepay.mock';

describe('GooglePayWorldpayInitializer', () => {
    let googlePayInitializer: GooglePayWorldpayInitializer;

    beforeEach(() => {
        googlePayInitializer = new GooglePayWorldpayInitializer();
    });

    it('creates an instance of GooglePayWorldpayInitializer', () => {
        expect(googlePayInitializer).toBeInstanceOf(GooglePayWorldpayInitializer);
    });

    describe('#initialize', () => {
        it('initializes the google pay configuration for Worldpay', async () => {
            const initialize = await googlePayInitializer.initialize(
                getCheckoutMock(),
                getWorldpayPaymentMethodMock(),
                false,
            );

            expect(initialize).toEqual(getWorldpayPaymentDataRequest());
        });

        it('initializes the google pay configuration for cybersourcev2 with Buy Now Flow', async () => {
            const paymentDataRequest = {
                ...getWorldpayPaymentDataRequest(),
                transactionInfo: {
                    ...getWorldpayPaymentDataRequest().transactionInfo,
                    currencyCode: '',
                    totalPrice: '',
                },
            };

            await googlePayInitializer
                .initialize(undefined, getWorldpayPaymentMethodMock(), false)
                .then((response) => {
                    expect(response).toEqual(paymentDataRequest);
                });
        });
    });

    describe('#teardown', () => {
        it('teardown the initializer', () => {
            expect(googlePayInitializer.teardown()).resolves.toBeUndefined();
        });
    });

    describe('#parseResponse', () => {
        it('parses a response from google pay payload received', async () => {
            const tokenizePayload = await googlePayInitializer.parseResponse(
                getWorldpayPaymentDataMock(),
            );

            expect(tokenizePayload).toEqual(getWorldpayTokenizedPayload());
        });
    });
});
