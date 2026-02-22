use anchor_lang::prelude::*;

declare_id!("A81Xsuwg5zrT1sgvkncemfWqQ8nymwHS3e7ExM4YnXMm");

#[program]
pub mod receipt {
    use super::*;

    pub fn record_execution(
        ctx: Context<RecordExecution>,
        epoch: u32,
        direction: u8,
        position_mint: Pubkey,
        tx_sig_hash: [u8; 32],
    ) -> Result<()> {
        require!(direction == 0 || direction == 1, ReceiptError::InvalidDirection);

        let authority = ctx.accounts.authority.key();
        let now = Clock::get()?;

        let receipt = &mut ctx.accounts.receipt;
        receipt.authority = authority;
        receipt.position_mint = position_mint;
        receipt.epoch = epoch;
        receipt.direction = direction;
        receipt.tx_sig_hash = tx_sig_hash;
        receipt.slot = now.slot;
        receipt.unix_ts = now.unix_timestamp;
        receipt.bump = ctx.bumps.receipt;

        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(epoch: u32, _direction: u8, position_mint: Pubkey, _tx_sig_hash: [u8; 32])]
pub struct RecordExecution<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init,
        payer = authority,
        space = Receipt::SPACE,
        seeds = [
            b"receipt",
            authority.key().as_ref(),
            position_mint.as_ref(),
            &epoch.to_le_bytes(),
        ],
        bump
    )]
    pub receipt: Account<'info, Receipt>,

    pub system_program: Program<'info, System>,
}

#[account]
pub struct Receipt {
    pub authority: Pubkey,
    pub position_mint: Pubkey,
    pub epoch: u32,
    pub direction: u8,
    pub tx_sig_hash: [u8; 32],
    pub slot: u64,
    pub unix_ts: i64,
    pub bump: u8,
}

impl Receipt {
    pub const SPACE: usize = 8  // discriminator
        + 32 // authority
        + 32 // position_mint
        + 4  // epoch
        + 1  // direction
        + 32 // tx_sig_hash
        + 8  // slot
        + 8  // unix_ts
        + 1; // bump
}

#[error_code]
pub enum ReceiptError {
    #[msg("Direction must be 0 (DOWN) or 1 (UP)")]
    InvalidDirection,
}
