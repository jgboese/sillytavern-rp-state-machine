import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { StateApp } from '../src/App';
import { RpStateMachine } from '../src/runtime';
import { emptyState, seedContainer } from '../src/persistence';
const fake = () => ({
  chat: [],
  chatId: 'chat',
  chatMetadata: {},
  extensionSettings: {},
  saveMetadata: vi.fn().mockResolvedValue(undefined),
  generateRaw: vi.fn(),
  eventSource: { on: vi.fn() },
  eventTypes: {},
});
describe('drawer', () => {
  it('uses accessible tabs and closes from its header control', () => {
    const context = fake();
    const state = emptyState('2026-01-01T00:00', 'Inn');
    context.chatMetadata = {
      rp_state_machine: seedContainer(state, 'prefix', 0),
    };
    const runtime = new RpStateMachine(() => context);
    render(<StateApp runtime={runtime} getContext={() => context} />);
    fireEvent.click(
      screen.getByRole('button', { name: 'Open RP State Machine' }),
    );
    expect(screen.getByRole('button', { name: 'Overview' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getByRole('button', { name: 'Save world' })).toHaveClass(
      'rpstate-button-primary',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Inventory' }));
    expect(screen.getByRole('button', { name: 'Inventory' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(screen.getByRole('button', { name: 'Reset state' })).toHaveClass(
      'rpstate-button-danger',
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Close RP State Machine' }),
    );
    expect(screen.queryByLabelText('RP State Machine')).not.toBeInTheDocument();
  });

  it('requires date and location seed confirmation', () => {
    const context = fake();
    const runtime = new RpStateMachine(() => context);
    render(<StateApp runtime={runtime} getContext={() => context} />);
    fireEvent.click(screen.getByText('State'));
    expect(screen.getByText('Seed this chat')).toBeInTheDocument();
    expect(screen.getByText('Save baseline')).toBeInTheDocument();
  });
  it('persists state-profile selection and refreshes profiles from lifecycle events', () => {
    const context = fake();
    const handlers: Record<string, () => void> = {};
    const profiles = [{ id: 'state', name: 'State', model: 'fast' }];
    (context as any).ConnectionManagerRequestService = {
      getSupportedProfiles: vi.fn(() => profiles),
    };
    context.eventTypes = { CONNECTION_PROFILE_CREATED: 'profile-created' };
    (context as any).eventSource = {
      on: vi.fn((type: string, handler: () => void) => {
        handlers[type] = handler;
      }),
      off: vi.fn(),
    };
    const state = emptyState('2026-01-01T00:00', 'Inn');
    context.chatMetadata = {
      rp_state_machine: seedContainer(state, 'prefix', 0),
    };
    const runtime = new RpStateMachine(() => context);
    const view = render(
      <StateApp runtime={runtime} getContext={() => context} />,
    );
    fireEvent.click(screen.getByText('State'));
    fireEvent.click(screen.getByText('Settings'));
    const profile = screen.getByLabelText('Connection profile');
    expect(profile).toHaveTextContent('State — fast');
    fireEvent.change(profile, { target: { value: 'state' } });
    expect(
      (context.extensionSettings as any).rp_state_machine.stateAgentProfileId,
    ).toBe('state');
    fireEvent.change(screen.getByLabelText('Maximum output tokens'), {
      target: { value: '700' },
    });
    expect(
      (context.extensionSettings as any).rp_state_machine.stateAgentMaxTokens,
    ).toBe(700);
    handlers['profile-created']();
    view.unmount();
    expect((context as any).eventSource.off).toHaveBeenCalledWith(
      'profile-created',
      expect.any(Function),
    );
  });
  it('shows an unavailable configured profile without replacing it', () => {
    const context = fake();
    context.extensionSettings = {
      rp_state_machine: { stateAgentProfileId: 'deleted-profile' },
    };
    const state = emptyState('2026-01-01T00:00', 'Inn');
    context.chatMetadata = {
      rp_state_machine: seedContainer(state, 'prefix', 0),
    };
    const runtime = new RpStateMachine(() => context);
    render(<StateApp runtime={runtime} getContext={() => context} />);
    fireEvent.click(screen.getByText('State'));
    fireEvent.click(screen.getByText('Settings'));
    expect(
      screen.getByRole('option', {
        name: 'Previously selected profile — unavailable',
      }),
    ).toBeDisabled();
    expect(screen.getByLabelText('Connection profile')).toHaveValue(
      'deleted-profile',
    );
  });
  it('synchronizes open editors when canonical state changes', async () => {
    const context = fake();
    const state = emptyState('2026-01-01T00:00', 'Inn');
    state.inventory.rope = { id: 'rope', name: 'Rope', quantity: 1 };
    context.chatMetadata = {
      rp_state_machine: seedContainer(state, 'prefix', 0),
    };
    const runtime = new RpStateMachine(() => context);
    const view = render(
      <StateApp runtime={runtime} getContext={() => context} />,
    );
    fireEvent.click(screen.getByText('State'));
    expect(screen.getByLabelText('Location')).toHaveValue('Inn');
    (context.chatMetadata as any).rp_state_machine.currentState.world.location =
      'Docks';
    view.rerender(<StateApp runtime={runtime} getContext={() => context} />);
    await waitFor(() =>
      expect(screen.getByLabelText('Location')).toHaveValue('Docks'),
    );
    fireEvent.click(screen.getByText('Inventory'));
    expect(screen.getByLabelText('Rope quantity')).toHaveValue(1);
    (
      context.chatMetadata as any
    ).rp_state_machine.currentState.inventory.rope.quantity = 4;
    view.rerender(<StateApp runtime={runtime} getContext={() => context} />);
    await waitFor(() =>
      expect(screen.getByLabelText('Rope quantity')).toHaveValue(4),
    );
  });
  it('shows rejected raw output and the latest relationship reason', () => {
    const context = fake();
    const state = emptyState('2026-01-01T00:00', 'Inn');
    state.characters.mira = {
      id: 'mira',
      displayName: 'Mira',
      aliases: [],
      conditions: [],
      relationship: { score: 1, lastReason: 'Shared a secret' },
    };
    const container = seedContainer(state, 'prefix', 0);
    container.reviewQueue.push({
      id: 'review',
      kind: 'extraction',
      message: 'Malformed',
      raw: '{bad json',
      createdAt: new Date().toISOString(),
    });
    context.chatMetadata = { rp_state_machine: container };
    const runtime = new RpStateMachine(() => context);
    render(<StateApp runtime={runtime} getContext={() => context} />);
    fireEvent.click(screen.getByText('State'));
    fireEvent.click(screen.getByText('Characters'));
    expect(screen.getByText(/Shared a secret/)).toBeInTheDocument();
    fireEvent.click(screen.getByText('History & Review'));
    expect(screen.getByText('{bad json')).toBeInTheDocument();
  });
});
