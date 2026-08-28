import {
  resolveServiceModel,
  showsCounterSaleTab,
  usesWaiterLedService,
} from '../serviceModel';

/**
 * The fail-safe direction is the whole point of this module, so it is what these pin.
 *
 * Getting it backwards does not produce a subtle bug: every terminal on an older deploy loses the
 * Sale tab it has had since June, at a venue that has never heard of waiter-led service. That is
 * why "absent" has its own case here rather than being folded into the false branch.
 */
describe('resolveServiceModel', () => {
  it('reads an explicit true as counter service', () => {
    expect(resolveServiceModel({isCounterService: true})).toBe('counter');
  });

  it('reads an explicit false as table service', () => {
    expect(resolveServiceModel({isCounterService: false})).toBe('table');
  });

  it('accepts the snake_case spelling', () => {
    expect(resolveServiceModel({is_counter_service: false})).toBe('table');
    expect(resolveServiceModel({is_counter_service: true})).toBe('counter');
  });

  it('treats an ABSENT field as unknown, never as table service', () => {
    expect(resolveServiceModel({})).toBe('unknown');
  });

  it('treats undefined and null payloads as unknown', () => {
    expect(resolveServiceModel(undefined)).toBe('unknown');
    expect(resolveServiceModel(null)).toBe('unknown');
  });

  it('treats a non-boolean as unknown rather than coercing it', () => {
    // A string 'false' is truthy in JS. Coercing here would flip a venue to table service on a
    // payload that literally says counter.
    expect(
      resolveServiceModel({isCounterService: 'false'} as never),
    ).toBe('unknown');
    expect(resolveServiceModel({isCounterService: 0} as never)).toBe('unknown');
  });
});

describe('the two navigator questions never disagree', () => {
  it('replaces Sale only for an explicit table-service venue', () => {
    expect(usesWaiterLedService('table')).toBe(true);
    expect(usesWaiterLedService('counter')).toBe(false);
    expect(usesWaiterLedService('unknown')).toBe(false);
  });

  it('keeps the Sale tab whenever the flow is not waiter-led', () => {
    expect(showsCounterSaleTab('counter')).toBe(true);
    expect(showsCounterSaleTab('unknown')).toBe(true);
    expect(showsCounterSaleTab('table')).toBe(false);
  });

  it('is exactly complementary for every model, so no venue gets both or neither', () => {
    for (const model of ['counter', 'table', 'unknown'] as const) {
      expect(showsCounterSaleTab(model)).toBe(!usesWaiterLedService(model));
    }
  });

  it('an unknown venue behaves identically to a counter one', () => {
    expect(usesWaiterLedService('unknown')).toBe(
      usesWaiterLedService('counter'),
    );
    expect(showsCounterSaleTab('unknown')).toBe(showsCounterSaleTab('counter'));
  });
});
