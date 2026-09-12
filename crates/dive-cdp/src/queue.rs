//! Nonblocking protocol ingress with both a byte and message budget.

use std::sync::Arc;
use tokio::sync::{OwnedSemaphorePermit, Semaphore, mpsc};

/// A message retains its byte reservation while the consumer parses it.
pub struct Message {
    /// The original protocol bytes, in arrival order.
    pub bytes: Vec<u8>,
    _reservation: OwnedSemaphorePermit,
}

/// The native callback never waits for space on the main thread.
pub struct Sender {
    tx: mpsc::Sender<Message>,
    budget: Arc<Semaphore>,
}

/// Create a bounded ingress queue. Rejection is explicit: the owner must stop
/// the unhealthy session rather than silently lose a reply or paused request.
pub fn bounded(messages: usize, bytes: usize) -> (Sender, mpsc::Receiver<Message>) {
    let (tx, rx) = mpsc::channel(messages);
    (
        Sender {
            tx,
            budget: Arc::new(Semaphore::new(bytes)),
        },
        rx,
    )
}

impl Sender {
    /// Admit a message without blocking, or return its bytes to the caller.
    pub fn try_send(&self, bytes: Vec<u8>) -> Result<(), Vec<u8>> {
        let Ok(size) = u32::try_from(bytes.len().max(1)) else {
            return Err(bytes);
        };
        let Ok(reservation) = self.budget.clone().try_acquire_many_owned(size) else {
            return Err(bytes);
        };
        self.tx
            .try_send(Message {
                bytes,
                _reservation: reservation,
            })
            .map_err(|e| e.into_inner().bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn byte_budget_includes_the_message_currently_being_parsed() {
        let (tx, mut rx) = bounded(8, 10);
        tx.try_send(vec![1; 6]).unwrap();
        let first = rx.recv().await.unwrap();
        assert!(tx.try_send(vec![2; 5]).is_err());
        tx.try_send(vec![3; 4]).unwrap();
        drop(first);
        tx.try_send(vec![4; 6]).unwrap();
        assert_eq!(rx.recv().await.unwrap().bytes, vec![3; 4]);
        assert_eq!(rx.recv().await.unwrap().bytes, vec![4; 6]);
    }

    #[tokio::test]
    async fn slot_pressure_and_closed_receiver_release_reservations() {
        let (tx, mut rx) = bounded(1, 10);
        tx.try_send(vec![1]).unwrap();
        assert!(tx.try_send(vec![2; 9]).is_err());
        drop(rx.recv().await);
        tx.try_send(vec![3; 10]).unwrap();
        drop(rx);
        assert!(tx.try_send(vec![4]).is_err());
    }
}
