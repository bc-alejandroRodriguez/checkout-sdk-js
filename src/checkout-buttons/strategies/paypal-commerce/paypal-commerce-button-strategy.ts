import { FormPoster } from '@bigcommerce/form-poster';
import { includes } from 'lodash';

import { Cart, CollectedLineItem, LineItemMap } from '../../../cart';
import { CheckoutActionCreator, CheckoutStore } from '../../../checkout';
import { InvalidArgumentError, MissingDataError, MissingDataErrorType, RequestError } from '../../../common/error/errors';
import { Country, Region, UnitedStatesCodes , UNITED_STATES_CODES } from '../../../geography';
import { OrderActionCreator } from '../../../order';
import { ApproveActions, ApproveDataOptions, AvaliableShippingOption, ButtonsOptions, Cache, CheckoutWithBillingAddress, ClickDataOptions, FundingType, PayerDetails, PaypalCommerceInitializationData, PaypalCommercePaymentProcessor, PaypalCommerceScriptParams, ShippingAddress, ShippingChangeData } from '../../../payment/strategies/paypal-commerce';
import { CheckoutButtonInitializeOptions } from '../../checkout-button-options';
import CheckoutButtonStrategy from '../checkout-button-strategy';

export default class PaypalCommerceButtonStrategy implements CheckoutButtonStrategy {
    private _isCredit?: boolean;
    private _cache?: Cache;
    private _submittedShippingAddress?: any;
    private _currentShippingAddress?: any;
    private _shippingOptionId?: string;
    private _intent?: string;

    constructor(
        private _store: CheckoutStore,
        private _checkoutActionCreator: CheckoutActionCreator,
        private _formPoster: FormPoster,
        private _paypalCommercePaymentProcessor: PaypalCommercePaymentProcessor,
        private _orderActionCreator?: OrderActionCreator
    ) {}

    async initialize(options: CheckoutButtonInitializeOptions): Promise<void> {
        let state = this._store.getState();
        const { initializationData } = state.paymentMethods.getPaymentMethodOrThrow(options.methodId);
        this._intent = initializationData.intent;
        const { isHosted } = initializationData;
        this._cache = {};
        if (!initializationData.clientId) {
            throw new InvalidArgumentError();
        }

        state = await this._store.dispatch(this._checkoutActionCreator.loadDefaultCheckout());
        const cart = state.cart.getCartOrThrow();
        const buttonParams: ButtonsOptions = {
            onApprove: (data: ApproveDataOptions, actions: ApproveActions) => isHosted ?
                this._onHostedMethodApprove( data, actions, cart) : this._tokenizePayment(data),
            onClick: data => this._handleClickButtonProvider(data),
            onShippingChange: (data, actions) => this._onShippingChangeHandler(data, actions, cart),
        };

        if (options.paypalCommerce && options.paypalCommerce.style) {
            buttonParams.style = options.paypalCommerce.style;
        }

        const messagingContainer = options.paypalCommerce?.messagingContainer;
        const isMessagesAvailable = Boolean(messagingContainer && document.getElementById(messagingContainer));

        await this._paypalCommercePaymentProcessor.initialize(this._getParamsScript(initializationData, cart));

        this._paypalCommercePaymentProcessor.renderButtons(cart.id, `#${options.containerId}`, buttonParams);

        if (isMessagesAvailable) {
            this._paypalCommercePaymentProcessor.renderMessages(cart.cartAmount, `#${messagingContainer}`);
        }

        return Promise.resolve();
    }

    deinitialize(): Promise<void> {
        this._isCredit = undefined;

        return Promise.resolve();
    }

    private _handleClickButtonProvider({ fundingSource }: ClickDataOptions): void {
        this._isCredit = fundingSource === 'credit' || fundingSource === 'paylater';
    }

    private _tokenizePayment({ orderID }: ApproveDataOptions) {
        if (!orderID) {
            throw new MissingDataError(MissingDataErrorType.MissingPayment);
        }

        return this._formPoster.postForm('/checkout.php', {
            payment_type: 'paypal',
            action: 'set_external_checkout',
            provider: this._isCredit ? 'paypalcommercecredit' : 'paypalcommerce',
            order_id: orderID,
        });
    }

    private _transformContactToAddress(details: PayerDetails, address: PayerDetails) {
        const contact = {
            firstName: details.payer.name.given_name,
            lastName: details.payer.name.surname,
            email: details.payer.email_address,
            address1: details.purchase_units[0].shipping.address.address_line_1,
        };

        return  {
            ...address,
            ...contact,
        };
    }

    private async _onHostedMethodApprove(_data: ApproveDataOptions, actions: ApproveActions, cart: Cart) {
        const orderPlacement = this._intent === 'capture'
            ? await actions.order.capture()
            : await actions.order.authorize();
        if (this._currentShippingAddress) {
                const shippingAddress = this._transformContactToAddress(orderPlacement, this._currentShippingAddress);
                const lineItems = this._collectLineItems(cart.lineItems);
                const consignmentPayload = [{
                    shippingAddress,
                    lineItems,
                }];
                try {
                    await this._paypalCommercePaymentProcessor.getConsignments(cart.id, consignmentPayload);
                    const checkoutWithBillingAddress = await this._paypalCommercePaymentProcessor.getBillingAddress(cart.id, shippingAddress) as CheckoutWithBillingAddress;
                    if (this._shippingOptionId) {
                        await this._paypalCommercePaymentProcessor.putConsignments(cart.id, checkoutWithBillingAddress.consignments[0].id, { shippingOptionId: this._shippingOptionId });
                    }
                    if (this._orderActionCreator) {
                        await this._store.dispatch(this._orderActionCreator.submitOrder({}, { params: {
                                methodId: 'paypalcommerce',
                                gatewayId: undefined,
                            }}));
                    }
                    await this._paypalCommercePaymentProcessor.deleteCart(checkoutWithBillingAddress.cart.id);
                    window.location.assign('/checkout/order-confirmation');
                } catch (e) {
                    throw new RequestError(e);
                }
            }

        return orderPlacement;
    }

    private async _onShippingChangeHandler(data: ShippingChangeData, actions: ApproveActions, cart: Cart) {
        const baseOrderAmount = cart.baseAmount;
        let shippingAmount = '0.00';
        this._currentShippingAddress = await this._transformToAddress(data.shipping_address);
        const lineItems = this._collectLineItems(cart.lineItems);
        const payload = [{
            shippingAddress: this._currentShippingAddress,
            lineItems,
        }];

        const checkout = await this._paypalCommercePaymentProcessor.getShippingOptions(cart.id, payload);
        const availableShippingOptions = (checkout as CheckoutWithBillingAddress).consignments[0].availableShippingOptions;
        const shippingRequired = (checkout as CheckoutWithBillingAddress ).cart.lineItems.physicalItems.length > 0;
        if (!shippingRequired) {
            const patch = await actions.order.patch([
                {
                    op: 'replace',
                    path: '/purchase_units/@reference_id==\'default\'/amount',
                    value: {
                        currency_code: 'USD',
                        value: (parseFloat(String(baseOrderAmount))).toFixed(2),
                        breakdown: {
                            item_total: {
                                currency_code: 'USD',
                                value: baseOrderAmount,
                            },
                        },
                    },
                },
            ]);

            return patch;
            // If no shipping options returned, but shipping is required, do not allow to submit such order
        } else if (shippingRequired && availableShippingOptions?.length === 0) {
            return actions.reject();
        } else {
            const shippingOptions = availableShippingOptions?.map((option: AvaliableShippingOption) => {
                let isSelected = false;
                // Buyer has chosen shipping option on PP list and address the same
                if (data.selected_shipping_option && this._isAddressSame(
                    this._currentShippingAddress, this._submittedShippingAddress
                )) {
                    if (option.id === data.selected_shipping_option.id) {
                        shippingAmount = data.selected_shipping_option.amount.value;
                        isSelected = true;
                    }
                } else {
                    if (option.isRecommended) {
                        shippingAmount = parseFloat(String(option.cost)).toFixed(2);
                        isSelected = true;
                    }
                }

                return {
                    id: option.id,
                    type: 'SHIPPING',
                    label: option.description,
                    selected: isSelected,
                    amount: {
                        value: parseFloat(String(option.cost)).toFixed(2),
                        currency_code: 'USD',
                    },
                };
            });

            shippingOptions?.sort( (a, b) => {
                return (a.selected === b.selected) ? 0 : a ? -1 : 1;
            });
            if (shippingOptions && shippingOptions[0].id) {
                this._shippingOptionId = shippingOptions[0].id;
            }
            this._submittedShippingAddress = this._currentShippingAddress;

            if (shippingOptions) {
                actions.order.patch([
                    {
                        op: 'replace',
                        path: '/purchase_units/@reference_id==\'default\'/amount',
                        value: {
                            currency_code: 'USD',
                            value: (parseFloat(String(baseOrderAmount)) + parseFloat(shippingAmount)).toFixed(2),
                            breakdown: {
                                item_total: {
                                    currency_code: 'USD',
                                    value: baseOrderAmount,
                                },
                                shipping: {
                                    currency_code: 'USD',
                                    value: shippingAmount,
                                },
                            },
                        },
                    },
                    {
                        op: 'add',
                        path: '/purchase_units/@reference_id==\'default\'/shipping/options',
                        value: shippingOptions,
                    },
                ]);
            }

            return actions.resolve();
        }
    }

    private _isAddressSame(address1: ShippingChangeData, address2: ShippingChangeData) {
        return JSON.stringify(address1) === JSON.stringify(address2);
    }

    private _transformUSCodes(code: string) {
       return  UNITED_STATES_CODES.find((state: UnitedStatesCodes) => {
            return state.name === code && state.abbreviation;
        });
    }

    private async _transformToAddress(contact: ShippingAddress) {
        const getCountries = await this._paypalCommercePaymentProcessor.getStoreCountries();
        const countries = this._cache?.countries || getCountries;
        if (this._cache) {
            this._cache.countries = countries;
        }
        const address = {
            city: contact.city,
            postalCode: contact.postal_code,
            countryCode: contact.country_code,
        };
        const addressCountry = countries.data.find((country: Country) => {
            return country.code === (contact.country_code || '').toUpperCase();
        });
        const stateAddress = addressCountry?.subdivisions.find((region: Region) => {

            return region.code === contact.state?.toUpperCase() || this._transformUSCodes(contact.state);
        });

        if (stateAddress) {
            address.postalCode = stateAddress.code;
        } else {
            throw new InvalidArgumentError('Invalid Address');
        }

        return address;
    }

    private _collectLineItems(lineItems: LineItemMap): CollectedLineItem[] {
        const { digitalItems, physicalItems  } = lineItems;

        return [...digitalItems, ...physicalItems].map(({ id, quantity }) => ({
            itemId: id,
            quantity,
        }));
    }

    private _getParamsScript(initializationData: PaypalCommerceInitializationData, cart: Cart): PaypalCommerceScriptParams {
        const {
            clientId,
            intent,
            isPayPalCreditAvailable,
            merchantId,
            attributionId,
            availableAlternativePaymentMethods = [],
            enabledAlternativePaymentMethods = [],
        } = initializationData;

        const disableFunding: FundingType = [ 'card' ];
        const enableFunding: FundingType = enabledAlternativePaymentMethods.slice();

        /**
         *  The default value is different depending on the countries,
         *  therefore there's a need to add credit, paylater or APM name to enable/disable funding explicitly
         */
        availableAlternativePaymentMethods.forEach(apm => {
            if (!includes(enabledAlternativePaymentMethods, apm)) {
                disableFunding.push(apm);
            }
        });

        if (isPayPalCreditAvailable) {
            enableFunding.push('credit', 'paylater');
        } else {
            disableFunding.push('credit', 'paylater');
        }

        return {
            'client-id': clientId,
            'merchant-id': merchantId,
            commit: false,
            currency: cart.currency.code,
            components: ['buttons', 'messages'],
            'disable-funding': disableFunding,
            ...(enableFunding.length && {'enable-funding': enableFunding}),
            intent,
            'data-partner-attribution-id': attributionId,
        };
    }
}
